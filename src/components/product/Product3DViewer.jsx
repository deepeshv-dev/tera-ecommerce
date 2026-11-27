
import '@google/model-viewer';
import { useEffect, useRef, useState } from 'react';

export default function Product3DViewer({ modelSrc, alt }) {
  const viewerRef = useRef(null);
  const [loadedModelSrc, setLoadedModelSrc] = useState(null);
  const [failedModelSrc, setFailedModelSrc] = useState(null);
  const [retryCount, setRetryCount] = useState(0);

  const hasModel = typeof modelSrc === 'string' && modelSrc.trim().length > 0;

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || !hasModel) return undefined;

    const modelIdentity = `${modelSrc}:${retryCount}`;
    if (viewer.loaded) {
      setLoadedModelSrc(modelIdentity);
    }
    const handleLoad = () => setLoadedModelSrc(modelIdentity);
    const handleError = () => setFailedModelSrc(modelIdentity);
    viewer.addEventListener('load', handleLoad);
    viewer.addEventListener('error', handleError);

    return () => {
      viewer.removeEventListener('load', handleLoad);
      viewer.removeEventListener('error', handleError);
    };
  }, [hasModel, modelSrc, retryCount]);

  if (!hasModel) {
    return (
      <div className="product-3d-placeholder" role="status">
        <div className="product-3d-placeholder-icon" aria-hidden="true">3D</div>
        <p>3D model coming soon</p>
      </div>
    );
  }

  const modelIdentity = `${modelSrc}:${retryCount}`;
  const isLoading = loadedModelSrc !== modelIdentity && failedModelSrc !== modelIdentity;
  const hasFailed = failedModelSrc === modelIdentity;

  return (
    <div className="product-3d-viewer">
      <model-viewer
        key={modelIdentity}
        ref={viewerRef}
        src={modelSrc}
        alt={alt}
        camera-controls
        touch-action="pan-y"
        auto-rotate
        auto-rotate-delay="3000"
        rotation-per-second="30deg"
        shadow-intensity="1"
        interaction-prompt="auto"
        loading="eager"
      />
      {isLoading && (
        <div className="product-3d-status" role="status">
          <span className="product-3d-spinner" aria-hidden="true" />
          <span>Loading 3D model...</span>
        </div>
      )}
      {hasFailed && (
        <div className="product-3d-status product-3d-status-error" role="alert">
          <span>Could not load this 3D model.</span>
          <button
            type="button"
            className="product-3d-retry"
            onClick={() => {
              setFailedModelSrc(null);
              setLoadedModelSrc(null);
              setRetryCount((count) => count + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
