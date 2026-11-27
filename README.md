# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## Product 3D models

Products with a verified local model use the `modelUrl` field in the catalog. Products without one show **3D model coming soon**. The existing Uno-style board and ESP32 DevKit GLBs are mapped to their corresponding products; they were downloaded previously and are not Meshy-generated.

To generate models from the catalog's existing product images:

1. Copy `.env.example` to `.env` and add a Meshy API key. Keep the key server-side; it must not use a `VITE_` prefix.
2. Preview the missing-model batch without sending requests:

   ```sh
   npm run generate:3d -- --all
   ```

3. If you have reviewed the estimated credit use and want to submit billable jobs for the 26 products without models, run:

   ```sh
   npm run generate:3d -- --all --confirm-cost
   ```

To request AI-generated models for all 28 products, including replacements for the two existing non-AI models, use `--all --regenerate --confirm-cost` instead. That is approximately 840 credits at the current settings; the missing-model batch is approximately 780 credits. The CLI shows the estimate before submitting and makes no requests without `--confirm-cost`.

The worker processes products sequentially, saves task IDs in the ignored `.local/` folder so pending tasks can be resumed, and downloads each successful GLB into `public/models` before Meshy's signed download URL expires. It then updates `src/data/productModelUrls.js`; Vite serves those models as static assets. Use `--product <id>` for a single product or `--retry-failed` with `--confirm-cost` to resubmit a failed task.

The current textured Meshy 7.1 API configuration costs about 30 credits per request. Failed tasks are not charged. A single input image cannot guarantee exact hidden-side details, so review every generated model against the actual product before publishing it. For deployments that do not retain repository static assets, move `public/models` to durable object storage/CDN before deployment.

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
