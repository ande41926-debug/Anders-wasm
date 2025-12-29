// Worker message types using discriminated unions
type LoadMessage = {
  id: string;
  type: 'load';
};

type GenerateMessage = {
  id: string;
  type: 'generate';
  imageData: string;
};

// Worker response types using discriminated unions
type LoadedResponse = {
  id: string;
  type: 'loaded';
};

type ResultResponse = {
  id: string;
  type: 'result';
  caption: string;
};

type ErrorResponse = {
  id: string;
  type: 'error';
  error: string;
};

type WorkerResponse = LoadedResponse | ResultResponse | ErrorResponse;

// Worker instance
let imageCaptioningWorker: Worker | null = null;

// Loading state
let isLoading = false;
let isLoaded = false;

/**
 * Convert image input to data URL string
 */
function imageToDataUrl(imageData: ImageData | HTMLImageElement | HTMLCanvasElement | string): string {
  if (typeof imageData === 'string') {
    return imageData; // Already a data URL
  }
  
  if (imageData instanceof HTMLCanvasElement) {
    return imageData.toDataURL('image/png');
  }
  
  if (imageData instanceof HTMLImageElement) {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get canvas context');
    }
    ctx.drawImage(imageData, 0, 0);
    return canvas.toDataURL('image/png');
  }
  
  // ImageData case
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/png');
}

// Progress callback type
export type ProgressCallback = (progress: number) => void;
export type LogCallback = (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;

/**
 * Load the ViT-GPT2 image-to-text model in Web Worker
 */
export async function loadImageCaptioningModel(
  onProgress?: ProgressCallback,
  onLog?: LogCallback
): Promise<void> {
  if (isLoaded && imageCaptioningWorker) {
    if (onLog) {
      onLog('Image captioning model already loaded', 'info');
    }
    return;
  }

  if (isLoading) {
    if (onLog) {
      onLog('Image captioning model is already loading...', 'info');
    }
    return;
  }

  isLoading = true;

  try {
    if (onLog) {
      onLog('Loading image captioning model in worker...', 'info');
    }

    if (onProgress) {
      onProgress(0);
    }

    imageCaptioningWorker = new Worker(
      new URL('./image-captioning.worker.ts', import.meta.url),
      { type: 'module' }
    );

    // Wait for worker to load model
    await new Promise<void>((resolve, reject) => {
      if (!imageCaptioningWorker) {
        reject(new Error('Failed to create worker'));
        return;
      }

      const worker = imageCaptioningWorker;
      const id = crypto.randomUUID();

      const handler = (event: MessageEvent<WorkerResponse>): void => {
        if (event.data.id !== id) {
          return;
        }

        worker.removeEventListener('message', handler);

        if (event.data.type === 'loaded') {
          resolve();
        } else if (event.data.type === 'error') {
          reject(new Error(event.data.error));
        }
      };

      worker.addEventListener('message', handler);

      const loadMessage: LoadMessage = { id, type: 'load' };
      worker.postMessage(loadMessage);
    });

    if (onProgress) {
      onProgress(100);
    }

    if (onLog) {
      onLog('Image captioning model loaded successfully', 'success');
    }

    isLoaded = true;
  } catch (error) {
    isLoading = false;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    // Provide more detailed error information
    let detailedError = errorMessage;
    if (errorMessage.includes('Unexpected token') || errorMessage.includes('DOCTYPE')) {
      detailedError = `${errorMessage}. This usually means the model files could not be downloaded from Hugging Face (CORS issue or model not found). Try refreshing the page or check your network connection.`;
    }
    
    if (onLog) {
      onLog(`Failed to load image captioning model: ${detailedError}`, 'error');
      onLog('Note: Transformers.js models are downloaded from Hugging Face. If this fails, it may be a CORS or network issue.', 'info');
    }
    throw new Error(`Failed to load image captioning model: ${detailedError}`);
  } finally {
    isLoading = false;
  }
}

/**
 * Generate image caption using Web Worker
 */
export async function generateCaption(
  imageData: ImageData | HTMLImageElement | HTMLCanvasElement | string,
  onLog?: LogCallback
): Promise<string> {
  if (!imageCaptioningWorker) {
    throw new Error('Image captioning model not loaded. Call loadImageCaptioningModel() first.');
  }

  try {
    if (onLog) {
      onLog('Generating image caption...', 'info');
    }

    // Convert image to data URL
    const dataUrl = imageToDataUrl(imageData);

    const worker = imageCaptioningWorker;

    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();

      const handler = (event: MessageEvent<WorkerResponse>): void => {
        if (event.data.id !== id) {
          return;
        }

        worker.removeEventListener('message', handler);

        if (event.data.type === 'result') {
          if (onLog) {
            const caption = event.data.caption;
            onLog(`Caption generated: ${caption.substring(0, 100)}${caption.length > 100 ? '...' : ''}`, 'success');
          }
          resolve(event.data.caption);
        } else if (event.data.type === 'error') {
          reject(new Error(event.data.error));
        }
      };

      worker.addEventListener('message', handler);

      const generateMessage: GenerateMessage = {
        id,
        type: 'generate',
        imageData: dataUrl,
      };

      worker.postMessage(generateMessage);
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    if (onLog) {
      onLog(`Image captioning error: ${errorMessage}`, 'error');
    }
    throw new Error(`Image captioning error: ${errorMessage}`);
  }
}


/**
 * Check if image captioning model is loaded
 */
export function isImageCaptioningModelLoaded(): boolean {
  return isLoaded && imageCaptioningWorker !== null;
}

/**
 * Get the model ID being used
 */
export function getModelId(): string {
  return 'Xenova/vit-gpt2-image-captioning';
}

