import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { products } from '../src/data/products.js';
import initialModelUrls from '../src/data/productModelUrls.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelMapPath = join(projectRoot, 'src', 'data', 'productModelUrls.js');
const modelDirectory = join(projectRoot, 'public', 'models');
const stateDirectory = join(projectRoot, '.local');
const taskStatePath = join(stateDirectory, 'meshy-tasks.json');
const lockPath = join(stateDirectory, 'meshy-generation.lock');
const defaultApiBaseUrl = 'https://api.meshy.ai';
const estimatedCreditsPerModel = 30;
const maxModelBytes = 200 * 1024 * 1024;
const maxTaskWaitMs = 60 * 60 * 1000;
const defaultPollIntervalMs = 5000;

class MeshyApiError extends Error {
  constructor(message, status, retryAfterMs) {
    super(message);
    this.name = 'MeshyApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function printHelp() {
  console.log(`Generate and store product-specific GLB models with Meshy.

Usage:
  npm run generate:3d -- --all
  npm run generate:3d -- --product 3
  npm run generate:3d -- --all --confirm-cost
  npm run generate:3d -- --product 3 --confirm-cost

Options:
  --all              Select products that do not already have a model.
  --product <id>     Select one product by catalog ID.
  --regenerate       Generate new models even for products with mapped models.
  --retry-failed     Allow a new request for products with a failed task.
  --confirm-cost     Allow billable API requests. Without this, the command is a dry run.
  --check-balance    Query available Meshy credit balance without submitting jobs.
  --help             Show this help.
`);
}

function parseArgs(args) {
  const options = {
    all: args.includes('--all'),
    confirmCost: args.includes('--confirm-cost'),
    regenerate: args.includes('--regenerate'),
    retryFailed: args.includes('--retry-failed'),
    checkBalance: args.includes('--check-balance'),
    help: args.includes('--help'),
    productId: null,
  };
  if (options.help || options.checkBalance) return options;
  const productIndex = args.indexOf('--product');

  if (productIndex !== -1) {
    const rawId = args[productIndex + 1];
    if (!rawId || rawId.startsWith('--') || !/^\d+$/.test(rawId)) {
      throw new Error('--product requires a numeric product ID.');
    }
    options.productId = Number(rawId);
  }

  const knownFlags = new Set([
    '--all',
    '--confirm-cost',
    '--regenerate',
    '--retry-failed',
    '--check-balance',
    '--help',
  ]);
  args.forEach((argument, index) => {
    if (knownFlags.has(argument)) return;
    if (argument === '--product') return;
    if (index === productIndex + 1) return;
    throw new Error(`Unknown option: ${argument}`);
  });

  if (options.all === (options.productId !== null)) {
    throw new Error('Choose exactly one of --all or --product <id>.');
  }
  if (options.retryFailed && !options.confirmCost) {
    throw new Error('--retry-failed requires --confirm-cost.');
  }
  if (options.regenerate && !options.confirmCost) {
    throw new Error('--regenerate requires --confirm-cost.');
  }

  return options;
}

async function loadDotEnv() {
  let contents;
  try {
    contents = await readFile(join(projectRoot, '.env'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]]) continue;

    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

function getApiBaseUrl() {
  const url = new URL(process.env.MESHY_API_BASE_URL || defaultApiBaseUrl);
  const isLocalHost = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(isLocalHost && url.protocol === 'http:')) {
    throw new Error('MESHY_API_BASE_URL must use HTTPS (HTTP is allowed for localhost tests only).');
  }
  return url.origin;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function safeMessage(message, apiKey) {
  const text = String(message || 'Unknown Meshy API error');
  return (apiKey ? text.replaceAll(apiKey, '[redacted]') : text).slice(0, 1000);
}

async function requestJson(url, apiKey, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(options.timeoutMs || 30_000),
    });
  } catch (error) {
    throw new MeshyApiError(error.message);
  }

  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  const responseText = await response.text();
  if (!response.ok) {
    throw new MeshyApiError(
      `Meshy returned HTTP ${response.status}: ${safeMessage(responseText, apiKey)}`,
      response.status,
      retryAfterMs,
    );
  }

  try {
    return {
      data: JSON.parse(responseText),
      retryAfterMs,
    };
  } catch {
    throw new MeshyApiError('Meshy returned an invalid JSON response.', response.status);
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readTaskState() {
  try {
    return JSON.parse(await readFile(taskStatePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Unable to read ${taskStatePath}: ${error.message}`, { cause: error });
  }
}

function serializeModelUrls(modelUrls) {
  const sortedEntries = Object.entries(modelUrls).sort(
    ([first], [second]) => Number(first) - Number(second),
  );
  return `const productModelUrls = ${JSON.stringify(Object.fromEntries(sortedEntries), null, 2)};\n\nexport default productModelUrls;\n`;
}

async function writeModelUrls(modelUrls) {
  const temporaryPath = `${modelMapPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, serializeModelUrls(modelUrls), 'utf8');
    await rename(temporaryPath, modelMapPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function acquireLock() {
  await mkdir(stateDirectory, { recursive: true });
  try {
    const lockHandle = await open(lockPath, 'wx');
    await lockHandle.writeFile(`${process.pid}\n`);
    return lockHandle;
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        'Another 3D model generation job is running. Check .local/meshy-generation.lock.',
        { cause: error },
      );
    }
    throw error;
  }
}

async function releaseLock(lockHandle) {
  await lockHandle.close();
  await rm(lockPath, { force: true });
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getImageHash(product) {
  return createHash('sha256').update(product.image).digest('hex');
}

function getTargetFileName(product, taskEntry, regenerate) {
  if (taskEntry?.fileName) return taskEntry.fileName;
  const suffix = regenerate ? `-ai-${Date.now()}` : '';
  return `${product.id}-${slugify(product.name)}${suffix}.glb`;
}

async function isValidGlb(path) {
  try {
    const fileStat = await stat(path);
    if (fileStat.size < 12 || fileStat.size > maxModelBytes) return false;
    const file = await open(path, 'r');
    const magic = Buffer.alloc(4);
    try {
      await file.read(magic, 0, magic.length, 0);
    } finally {
      await file.close();
    }
    return magic.toString('ascii') === 'glTF';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function productHasModel(product) {
  if (!product.modelUrl) return false;
  if (!product.modelUrl.startsWith('/models/')) return true;

  const modelPathParts = product.modelUrl.slice('/models/'.length).split('/');
  if (modelPathParts.some((part) => !part || part === '..')) return false;
  return isValidGlb(join(modelDirectory, ...modelPathParts));
}

async function createTask(product, apiBaseUrl, apiKey) {
  const imageUrl = new URL(product.image);
  if (!['http:', 'https:'].includes(imageUrl.protocol)) {
    throw new Error(`Product ${product.id} has an unsupported image URL.`);
  }

  const { data } = await requestJson(
    `${apiBaseUrl}/openapi/v1/image-to-3d`,
    apiKey,
    {
      method: 'POST',
      timeoutMs: 60_000,
      body: {
        image_url: product.image,
        ai_model: 'latest',
        should_texture: true,
        should_remesh: true,
        target_polycount: 30_000,
        target_formats: ['glb'],
      },
    },
  );

  if (typeof data.result !== 'string' || !data.result) {
    throw new Error('Meshy did not return a task ID. The request was not retried to avoid duplicate charges.');
  }
  return data.result;
}

async function getTask(taskId, apiBaseUrl, apiKey) {
  return requestJson(
    `${apiBaseUrl}/openapi/v1/image-to-3d/${encodeURIComponent(taskId)}`,
    apiKey,
  );
}

async function getBalance(apiBaseUrl, apiKey) {
  try {
    const { data } = await requestJson(`${apiBaseUrl}/openapi/v1/balance`, apiKey);
    return data;
  } catch (error) {
    console.warn(`  Could not check account balance: ${safeMessage(error.message, apiKey)}`);
    return null;
  }
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function pollTask(taskId, entry, state, apiBaseUrl, apiKey) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < maxTaskWaitMs) {
    let result;
    try {
      result = await getTask(taskId, apiBaseUrl, apiKey);
    } catch (error) {
      const transient = !error.status || error.status === 429 || error.status >= 500;
      if (!transient) throw error;
      console.warn(`  Temporary status-check error: ${safeMessage(error.message, apiKey)}`);
      const remaining = maxTaskWaitMs - (Date.now() - startedAt);
      await sleep(Math.min(error.retryAfterMs ?? defaultPollIntervalMs, Math.max(remaining, 0)));
      continue;
    }

    const task = result.data;
    const status = String(task.status || '').toUpperCase();
    entry.status = status;
    entry.progress = Number.isFinite(task.progress) ? task.progress : null;
    await writeJsonAtomic(taskStatePath, state);
    console.log(`  Meshy status: ${status || 'unknown'}${entry.progress === null ? '' : ` (${entry.progress}%)`}`);

    if (status === 'SUCCEEDED') return task;
    if (status === 'FAILED' || status === 'CANCELED') {
      const details = task.task_error?.message || task.message || 'Meshy task failed.';
      throw new Error(safeMessage(details, apiKey));
    }
    if (!['PENDING', 'IN_PROGRESS'].includes(status)) {
      throw new Error(`Meshy returned an unsupported task status: ${status || 'empty'}`);
    }

    const remaining = maxTaskWaitMs - (Date.now() - startedAt);
    const delay = result.retryAfterMs ?? defaultPollIntervalMs;
    await sleep(Math.min(delay, Math.max(remaining, 0)));
  }

  throw new Error('Meshy task is still running after 60 minutes. Its task ID is saved and can be resumed later.');
}

async function downloadGlb(downloadUrl, targetPath, apiBaseUrl) {
  const url = new URL(downloadUrl);
  const localApiHost = new URL(apiBaseUrl).hostname;
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname))
  ) {
    throw new Error('Meshy returned a model download URL that is not HTTPS.');
  }
  if (url.hostname !== 'assets.meshy.ai' && url.hostname !== localApiHost) {
    throw new Error(`Unexpected model host returned by Meshy: ${url.hostname}`);
  }

  const response = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`GLB download failed with HTTP ${response.status}.`);
  const finalDownloadUrl = new URL(response.url);
  const isLocalDownload = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(finalDownloadUrl.hostname);
  if (finalDownloadUrl.protocol !== 'https:' && !(isLocalDownload && finalDownloadUrl.protocol === 'http:')) {
    throw new Error('The redirected model download URL is not HTTPS.');
  }
  if (finalDownloadUrl.hostname !== 'assets.meshy.ai' && finalDownloadUrl.hostname !== localApiHost) {
    throw new Error(`Unexpected redirected model host: ${finalDownloadUrl.hostname}`);
  }
  if (!response.body) throw new Error('Meshy returned an empty GLB download.');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxModelBytes) {
    throw new Error('The generated GLB exceeds the 200 MB safety limit.');
  }

  const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  let downloadedBytes = 0;
  const sizeLimit = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length;
      if (downloadedBytes > maxModelBytes) {
        callback(new Error('The generated GLB exceeds the 200 MB safety limit.'));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      sizeLimit,
      createWriteStream(temporaryPath, { flags: 'wx' }),
    );

    if (!(await isValidGlb(temporaryPath))) {
      throw new Error('The downloaded file is not a valid GLB model.');
    }

    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return downloadedBytes;
}

async function processProduct(product, modelUrls, state, options, apiBaseUrl, apiKey) {
  const productId = String(product.id);
  let entry = state[productId];
  const imageHash = getImageHash(product);

  if (
    entry &&
    ['PENDING', 'IN_PROGRESS', 'SUCCEEDED'].includes(entry.status) &&
    entry.taskId
  ) {
    if (entry.imageHash !== imageHash) {
      throw new Error('A saved task for this product uses a different image. Review .local/meshy-tasks.json before retrying.');
    }
    console.log(`  Resuming saved Meshy task ${entry.taskId}.`);
  } else {
    if (entry?.status === 'FAILED' && !options.retryFailed) {
      throw new Error('The previous task failed. Use --retry-failed --confirm-cost to submit another billable request.');
    }

    const fileName = getTargetFileName(product, null, options.regenerate);
    const targetPath = join(modelDirectory, fileName);
    if (!options.regenerate && await isValidGlb(targetPath)) {
      modelUrls[productId] = `/models/${fileName}`;
      await writeModelUrls(modelUrls);
      console.log(`  Recovered existing GLB: ${fileName}`);
      return;
    }

    console.log('  Submitting image-to-3D task...');
    let taskId;
    try {
      taskId = await createTask(product, apiBaseUrl, apiKey);
    } catch (error) {
      throw new Error(
        `${error.message} The submission was not retried; check Meshy's task history before trying again.`,
        { cause: error },
      );
    }
    entry = {
      taskId,
      imageHash,
      fileName,
      startedAt: new Date().toISOString(),
      status: 'PENDING',
      progress: null,
    };
    state[productId] = entry;
    await writeJsonAtomic(taskStatePath, state);
  }

  let task;
  try {
    task = await pollTask(entry.taskId, entry, state, apiBaseUrl, apiKey);
  } catch (error) {
    if (error.message.startsWith('Meshy task is still running')) throw error;
    entry.status = 'FAILED';
    entry.error = safeMessage(error.message, apiKey);
    await writeJsonAtomic(taskStatePath, state);
    throw error;
  }

  const glbUrl = task.model_urls?.glb;
  if (typeof glbUrl !== 'string' || !glbUrl) {
    entry.status = 'FAILED';
    entry.error = 'Meshy succeeded without returning a GLB URL.';
    await writeJsonAtomic(taskStatePath, state);
    throw new Error(entry.error);
  }

  const targetPath = join(modelDirectory, entry.fileName);
  await mkdir(modelDirectory, { recursive: true });
  const size = await isValidGlb(targetPath)
    ? (await stat(targetPath)).size
    : await downloadGlb(glbUrl, targetPath, apiBaseUrl);
  modelUrls[productId] = `/models/${entry.fileName}`;
  await writeModelUrls(modelUrls);

  entry.status = 'SUCCEEDED';
  entry.progress = 100;
  entry.modelUrl = modelUrls[productId];
  entry.fileSize = size;
  delete entry.error;
  await writeJsonAtomic(taskStatePath, state);
  console.log(`  Saved ${entry.modelUrl} (${size.toLocaleString()} bytes).`);
}

function getSelectedProducts(options) {
  if (options.all) return products;
  const product = products.find((item) => item.id === options.productId);
  if (!product) throw new Error(`No product with ID ${options.productId} exists in the catalog.`);
  return [product];
}

async function main() {
  await loadDotEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  if (options.checkBalance) {
    const apiKey = process.env.MESHY_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('MESHY_API_KEY is missing. Copy .env.example to .env and add your Meshy API key.');
    }
    const apiBaseUrl = getApiBaseUrl();
    console.log('Checking Meshy credit balance...');
    const balanceInfo = await getBalance(apiBaseUrl, apiKey);
    if (balanceInfo) {
      console.log(`Current Meshy balance: ${balanceInfo.balance} credits (monthly: ${balanceInfo.monthly_credits ?? 0}, permanent: ${balanceInfo.permanent_credits ?? 0}).`);
    } else {
      console.log('Unable to retrieve balance information.');
    }
    return;
  }

  const selectedProducts = getSelectedProducts(options);
  const modelUrls = { ...initialModelUrls };
  const selectedWithoutModels = [];
  for (const product of selectedProducts) {
    if (options.regenerate || !(await productHasModel(product))) {
      selectedWithoutModels.push(product);
    }
  }

  console.log(`Selected ${selectedProducts.length} product(s); ${selectedWithoutModels.length} need a model.`);
  if (!selectedWithoutModels.length) {
    console.log('No generation requests are needed.');
    return;
  }

  const maximumEstimate = selectedWithoutModels.length * estimatedCreditsPerModel;
  console.log(
    `Maximum estimate for new textured Meshy 7.1 tasks: ${maximumEstimate} credits ` +
      `(${estimatedCreditsPerModel} per product; failed tasks are not charged).`,
  );

  if (!options.confirmCost) {
    console.log('Dry run only: no Meshy API requests were sent.');
    console.log('After configuring MESHY_API_KEY, add --confirm-cost to submit billable requests.');
    return;
  }

  const apiKey = process.env.MESHY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('MESHY_API_KEY is missing. Copy .env.example to .env and add your Meshy API key.');
  }

  const apiBaseUrl = getApiBaseUrl();

  const balanceInfo = await getBalance(apiBaseUrl, apiKey);
  if (balanceInfo && typeof balanceInfo.balance === 'number') {
    console.log(`Current Meshy balance: ${balanceInfo.balance} credits (monthly: ${balanceInfo.monthly_credits ?? 0}, permanent: ${balanceInfo.permanent_credits ?? 0}).`);
    if (balanceInfo.balance < maximumEstimate) {
      const affordableCount = Math.floor(balanceInfo.balance / estimatedCreditsPerModel);
      console.warn(`WARNING: Account balance (${balanceInfo.balance} credits) is lower than the full batch estimate (${maximumEstimate} credits needed for ${selectedWithoutModels.length} models).`);
      if (affordableCount <= 0) {
        throw new Error(`Insufficient credits. You have ${balanceInfo.balance} credits, but at least ${estimatedCreditsPerModel} are required per model.`);
      }
      console.log(`Proceeding with the first ${affordableCount} product(s) supported by your available credits.`);
      selectedWithoutModels.splice(affordableCount);
    }
  }

  const lockHandle = await acquireLock();
  let succeeded = 0;
  let failed = 0;

  try {
    const state = await readTaskState();
    for (const product of selectedWithoutModels) {
      console.log(`\n[${product.id}/${products.length}] ${product.name}`);
      try {
        await processProduct(product, modelUrls, state, options, apiBaseUrl, apiKey);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        console.error(`  Failed: ${safeMessage(error.message, apiKey)}`);
      }
    }
  } finally {
    await releaseLock(lockHandle);
  }

  console.log(`\nGeneration run finished: ${succeeded} succeeded, ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

const isMainModule =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
