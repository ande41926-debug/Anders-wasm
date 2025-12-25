import type { WasmModulePreprocess } from '../types';
import { loadWasmModule, validateWasmModule } from '../wasm/loader';
import { WasmLoadError, WasmInitError } from '../wasm/types';
import { pipeline, env } from '@xenova/transformers';

// Configure Transformers.js for browser use
env.allowLocalModels = false;
env.allowRemoteModels = true;

// Use a CORS proxy to avoid 401 errors when fetching models from Hugging Face
// This allows the browser to fetch models that would otherwise be blocked by CORS
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  // Only proxy Hugging Face requests
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('huggingface.co') && !url.includes('cdn.jsdelivr.net')) {
    // Use a CORS proxy - allorigins is a public CORS proxy service
    const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
    return originalFetch(proxyUrl, init);
  }
  // For non-Hugging Face requests, use original fetch
  return originalFetch(input, init);
};

// Lazy WASM import - only load when init() is called
// Using a getter function to defer the import until actually needed
let wasmModuleExports: {
  default: () => Promise<unknown>;
  normalize_text: (text: string) => string;
  preprocess_text: (text: string) => Uint32Array;
  preprocess_image: (imageData: Uint8Array, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) => Uint8Array;
  get_preprocess_stats: (originalSize: number, targetSize: number) => PreprocessStats;
} | null = null;

const getInitWasm = async (): Promise<unknown> => {
  if (!wasmModuleExports) {
    // Import only when first called - get both init and exported functions
    wasmModuleExports = await import('../../pkg/wasm_preprocess/wasm_preprocess.js');
  }
  return wasmModuleExports.default();
};

interface PreprocessStats {
  original_size: number;
  target_size: number;
  scale_factor: number;
}

let wasmModule: WasmModulePreprocess | null = null;
let smolvlmPipeline: Awaited<ReturnType<typeof pipeline>> | null = null;

// Type for wasm-bindgen exports
interface WasmBindgenExports {
  memory?: WebAssembly.Memory;
  preprocess_image?: (imageData: Uint8Array, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number) => Uint8Array;
  preprocess_text?: (text: string) => Uint32Array;
  normalize_text?: (text: string) => string;
  get_preprocess_stats?: (originalSize: number, targetSize: number) => PreprocessStats;
}

function validatePreprocessModule(exports: unknown): WasmModulePreprocess | null {
  if (!validateWasmModule(exports)) {
    return null;
  }
  
  if (typeof exports !== 'object' || exports === null) {
    return null;
  }
  
  // Check for required exports and provide detailed error info
  // Use Object.getOwnPropertyDescriptor to access properties without type assertion
  const getProperty = (obj: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(obj, key);
    return descriptor ? descriptor.value : undefined;
  };
  
  const exportKeys = Object.keys(exports);
  const missingExports: string[] = [];
  
  // Check for required exports
  const memoryValue = getProperty(exports, 'memory');
  if (!memoryValue || !(memoryValue instanceof WebAssembly.Memory)) {
    missingExports.push('memory (WebAssembly.Memory)');
  }
  if (!('preprocess_image' in exports)) {
    missingExports.push('preprocess_image');
  }
  if (!('preprocess_text' in exports)) {
    missingExports.push('preprocess_text');
  }
  if (!('normalize_text' in exports)) {
    missingExports.push('normalize_text');
  }
  if (!('get_preprocess_stats' in exports)) {
    missingExports.push('get_preprocess_stats');
  }
  
  if (missingExports.length > 0) {
    // Throw error with details for debugging
    throw new Error(`WASM module missing required exports: ${missingExports.join(', ')}. Available exports: ${exportKeys.join(', ')}`);
  }
  
  // At this point we know memory exists and is WebAssembly.Memory
  const memory = memoryValue;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('WASM module memory is not WebAssembly.Memory');
  }
  
  // Create exports record for function access
  const exportsRecord: Record<string, unknown> = {};
  for (const key of exportKeys) {
    exportsRecord[key] = getProperty(exports, key);
  }
  
  // Type guard to check if result has expected structure (memory from init result)
  const initResult: WasmBindgenExports = 
    typeof exports === 'object' && exports !== null
      ? exports
      : {};
  
  // Use the high-level exported functions directly from the module, not from init result
  // The init result has low-level WASM functions, but the module exports high-level wrappers
  if (
    initResult.memory &&
    initResult.memory instanceof WebAssembly.Memory &&
    wasmModuleExports &&
    typeof wasmModuleExports.preprocess_image === 'function' &&
    typeof wasmModuleExports.preprocess_text === 'function' &&
    typeof wasmModuleExports.normalize_text === 'function' &&
    typeof wasmModuleExports.get_preprocess_stats === 'function'
  ) {
    const module: WasmModulePreprocess = {
      memory: initResult.memory,
      preprocess_image: wasmModuleExports.preprocess_image,
      preprocess_text: wasmModuleExports.preprocess_text,
      normalize_text: wasmModuleExports.normalize_text,
      get_preprocess_stats: wasmModuleExports.get_preprocess_stats,
    };
    return module;
  }
  
  return null;
}

export const init = async (): Promise<void> => {
  const errorDiv = document.getElementById('error');
  const loadingIndicator = document.getElementById('loadingIndicator');
  const processImageBtn = document.getElementById('processImageBtn');
  const processTextBtn = document.getElementById('processTextBtn');
  
  try {
    // Show loading state
    if (loadingIndicator) {
      loadingIndicator.textContent = 'Loading WASM preprocessing module...';
    }
    
    // Disable buttons until WASM is ready
    if (processImageBtn instanceof HTMLButtonElement) {
      processImageBtn.disabled = true;
    }
    if (processTextBtn instanceof HTMLButtonElement) {
      processTextBtn.disabled = true;
    }
    
    // Use loadWasmModule for proper error handling
    // This will initialize the WASM module and validate exports
    wasmModule = await loadWasmModule<WasmModulePreprocess>(
      getInitWasm,
      validatePreprocessModule
    );
    
    // Verify module is ready
    if (!wasmModule) {
      throw new WasmInitError('WASM module failed validation');
    }
    
    // Hide loading, show ready state
    if (loadingIndicator) {
      loadingIndicator.textContent = 'WASM preprocessing module ready!';
      // Clear after 2 seconds using requestAnimationFrame
      const startTime = performance.now();
      const clearAfterDelay = (): void => {
        if (loadingIndicator) {
          const elapsed = performance.now() - startTime;
          if (elapsed >= 2000) {
            loadingIndicator.textContent = '';
          } else {
            requestAnimationFrame(clearAfterDelay);
          }
        }
      };
      requestAnimationFrame(clearAfterDelay);
    }
    
    // Load image captioning model
    // Note: SmolVLM-500M uses idefics3 architecture which isn't supported by Transformers.js yet
    // Using a supported alternative model (BLIP) for image captioning
    if (loadingIndicator) {
      loadingIndicator.textContent = 'Loading image captioning model...';
    }
    
    try {
      // Load image-to-text pipeline with a supported model
      // Note: Some models may have CORS/authentication issues in browser
      // We'll try the model and handle errors gracefully
      smolvlmPipeline = await pipeline(
        'image-to-text',
        'Xenova/vit-gpt2-image-captioning', // Using vit-gpt2 which is more likely to work
        {
          quantized: true,
        }
      );
      
      if (loadingIndicator) {
        loadingIndicator.textContent = 'Image captioning model ready!';
        const startTime = performance.now();
        const clearAfterDelay = (): void => {
          if (loadingIndicator) {
            const elapsed = performance.now() - startTime;
            if (elapsed >= 2000) {
              loadingIndicator.textContent = '';
            } else {
              requestAnimationFrame(clearAfterDelay);
            }
          }
        };
        requestAnimationFrame(clearAfterDelay);
      }
    } catch (error) {
      if (loadingIndicator) {
        loadingIndicator.textContent = '';
      }
      if (errorDiv) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        // Check if it's a 401/CORS error and provide helpful message
        if (errorMsg.includes('401') || errorMsg.includes('Unauthorized') || errorMsg.includes('CORS')) {
          errorDiv.textContent = 'Image captioning model unavailable (CORS/auth issue). WASM preprocessing works perfectly!';
        } else {
          errorDiv.textContent = `Image captioning model failed to load: ${errorMsg}. WASM preprocessing still works.`;
        }
      }
      // Continue without model - preprocessing still works
      smolvlmPipeline = null;
    }
    
    // Enable buttons now that WASM is ready
    if (processImageBtn instanceof HTMLButtonElement) {
      processImageBtn.disabled = false;
    }
    if (processTextBtn instanceof HTMLButtonElement) {
      processTextBtn.disabled = false;
    }
    
    // Setup UI only after WASM is confirmed ready
    setupUI();
  } catch (error) {
    // Clear loading indicator
    if (loadingIndicator) {
      loadingIndicator.textContent = '';
    }
    
    // Disable buttons on error
    if (processImageBtn instanceof HTMLButtonElement) {
      processImageBtn.disabled = true;
    }
    if (processTextBtn instanceof HTMLButtonElement) {
      processTextBtn.disabled = true;
    }
    
    // Show detailed error
    if (errorDiv) {
      if (error instanceof WasmLoadError) {
        errorDiv.textContent = `Failed to load WASM preprocessing module: ${error.message}`;
      } else if (error instanceof WasmInitError) {
        errorDiv.textContent = `WASM preprocessing module initialization failed: ${error.message}`;
      } else if (error instanceof Error) {
        errorDiv.textContent = `Error: ${error.message}`;
      } else {
        errorDiv.textContent = 'Unknown error loading WASM preprocessing module';
      }
    }
  }
};

function setupUI(): void {
  const imageInputEl = document.getElementById('imageInput');
  const textInputEl = document.getElementById('textInput');
  const processImageBtn = document.getElementById('processImageBtn');
  const processTextBtn = document.getElementById('processTextBtn');
  const imageOutputEl = document.getElementById('imageOutput');
  const textOutputEl = document.getElementById('textOutput');
  const statsOutputEl = document.getElementById('statsOutput');
  const imagePreviewEl = document.getElementById('imagePreview');
  const imagePreviewContainerEl = document.getElementById('imagePreviewContainer');
  const webcamVideoEl = document.getElementById('webcamVideo');
  const startWebcamBtn = document.getElementById('startWebcamBtn');
  const stopWebcamBtn = document.getElementById('stopWebcamBtn');
  const snapshotBtn = document.getElementById('snapshotBtn');

  if (
    !imageInputEl ||
    !textInputEl ||
    !processImageBtn ||
    !processTextBtn ||
    !imageOutputEl ||
    !textOutputEl ||
    !statsOutputEl ||
    !imagePreviewEl ||
    !imagePreviewContainerEl ||
    !webcamVideoEl ||
    !startWebcamBtn ||
    !stopWebcamBtn ||
    !snapshotBtn ||
    !(imageInputEl instanceof HTMLInputElement) ||
    !(textInputEl instanceof HTMLTextAreaElement) ||
    !(imageOutputEl instanceof HTMLCanvasElement) ||
    !(textOutputEl instanceof HTMLPreElement) ||
    !(statsOutputEl instanceof HTMLDivElement) ||
    !(imagePreviewEl instanceof HTMLImageElement) ||
    !(imagePreviewContainerEl instanceof HTMLDivElement) ||
    !(webcamVideoEl instanceof HTMLVideoElement) ||
    !(startWebcamBtn instanceof HTMLButtonElement) ||
    !(stopWebcamBtn instanceof HTMLButtonElement) ||
    !(snapshotBtn instanceof HTMLButtonElement)
  ) {
    throw new Error('Required UI elements not found');
  }

  const imageInput = imageInputEl;
  const textInput = textInputEl;
  const imageOutput = imageOutputEl;
  const textOutput = textOutputEl;
  const statsOutput = statsOutputEl;
  const imagePreview = imagePreviewEl;
  const imagePreviewContainer = imagePreviewContainerEl;

  // Initially hide preview container
  imagePreviewContainer.style.display = 'none';

  // Handle file input change to show preview
  imageInput.addEventListener('change', () => {
    if (imageInput.files && imageInput.files.length > 0) {
      const file = imageInput.files[0];
      const url = URL.createObjectURL(file);
      
      imagePreview.onload = () => {
        URL.revokeObjectURL(url);
        imagePreviewContainer.style.display = 'block';
      };
      
      imagePreview.onerror = () => {
        URL.revokeObjectURL(url);
        imagePreviewContainer.style.display = 'none';
        alert('Failed to load image preview');
      };
      
      imagePreview.src = url;
    } else {
      imagePreviewContainer.style.display = 'none';
      imagePreview.src = '';
    }
  });

  processImageBtn.addEventListener('click', () => {
    if (!imageInput.files || imageInput.files.length === 0) {
      alert('Please select an image file');
      return;
    }
    void processImage(imageInput.files[0], imageOutput, statsOutput);
  });

  processTextBtn.addEventListener('click', () => {
    const text = textInput.value;
    if (!text.trim()) {
      alert('Please enter some text');
      return;
    }
    processText(text, textOutput);
  });
  
  // Webcam functionality
  let mediaStream: MediaStream | null = null;
  
  startWebcamBtn.addEventListener('click', () => {
    void (async () => {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      
      webcamVideoEl.srcObject = mediaStream;
      webcamVideoEl.style.display = 'block';
      startWebcamBtn.style.display = 'none';
      stopWebcamBtn.style.display = 'inline-block';
      snapshotBtn.style.display = 'inline-block';
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      alert(`Failed to access webcam: ${errorMsg}`);
    }
    })();
  });
  
  stopWebcamBtn.addEventListener('click', () => {
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop());
      mediaStream = null;
    }
    webcamVideoEl.srcObject = null;
    webcamVideoEl.style.display = 'none';
    startWebcamBtn.style.display = 'inline-block';
    stopWebcamBtn.style.display = 'none';
    snapshotBtn.style.display = 'none';
  });
  
  snapshotBtn.addEventListener('click', () => {
    if (!webcamVideoEl.srcObject) {
      alert('Webcam not started');
      return;
    }
    
    // Create canvas to capture frame
    const snapshotCanvas = document.createElement('canvas');
    snapshotCanvas.width = webcamVideoEl.videoWidth;
    snapshotCanvas.height = webcamVideoEl.videoHeight;
    const ctx = snapshotCanvas.getContext('2d');
    if (!ctx) {
      alert('Failed to get canvas context');
      return;
    }
    
    ctx.drawImage(webcamVideoEl, 0, 0);
    
    // Convert canvas to blob and create File object
    snapshotCanvas.toBlob((blob) => {
      if (!blob) {
        alert('Failed to capture snapshot');
        return;
      }
      
      // Create File object from blob
      const file = new File([blob], 'snapshot.png', { type: 'image/png' });
      
      // Set file input (if possible) or process directly
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      if (imageInputEl instanceof HTMLInputElement) {
        imageInputEl.files = dataTransfer.files;
      }
      
      // Show preview
      const url = URL.createObjectURL(blob);
      imagePreviewEl.src = url;
      imagePreviewContainerEl.style.display = 'block';
      imagePreviewEl.onload = () => {
        URL.revokeObjectURL(url);
      };
      
      // Auto-process the snapshot
      void processImage(file, imageOutputEl, statsOutputEl);
    }, 'image/png');
  });
}

function processImage(file: File, canvas: HTMLCanvasElement, statsDiv: HTMLDivElement): Promise<void> {
  const module = wasmModule;
  if (!module) {
    return Promise.reject(new Error('WASM module not initialized'));
  }

  return new Promise<void>((resolve, reject) => {
    // Read the original file bytes (PNG/JPEG encoded data)
    const fileReader = new FileReader();
    
    fileReader.onload = () => {
      const fileData = fileReader.result;
      if (!(fileData instanceof ArrayBuffer)) {
        reject(new Error('Failed to read file as ArrayBuffer'));
        return;
      }
      
      const imageBytes = new Uint8Array(fileData);
      
      // Load image to get dimensions for display
      const img = new Image();
      const url = URL.createObjectURL(file);
      
      img.onload = async () => {
        URL.revokeObjectURL(url);
        
        // Target size for preprocessing (384×384)
        // This size is commonly used for ML model inputs
        const targetWidth = 384;
        const targetHeight = 384;
        
        // Preprocess image - pass original file bytes (PNG/JPEG encoded)
        let processedData: Uint8Array;
        try {
          processedData = module.preprocess_image(
            imageBytes,
            img.width,
            img.height,
            targetWidth,
            targetHeight
          );
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error';
          reject(new Error(`WASM preprocessing failed: ${errorMsg}`));
          return;
        }
        
        // Display processed image
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Failed to get canvas context'));
          return;
        }
        const processedImageData = new ImageData(
          new Uint8ClampedArray(processedData),
          targetWidth,
          targetHeight
        );
        ctx.putImageData(processedImageData, 0, 0);
        
        // Display stats
        const stats = module.get_preprocess_stats(img.width, targetWidth);
        statsDiv.innerHTML = `
          <h3>Preprocessing Stats</h3>
          <p>Original: ${stats.original_size}x${stats.original_size}</p>
          <p>Target: ${stats.target_size}x${stats.target_size}</p>
          <p>Scale Factor: ${stats.scale_factor.toFixed(2)}</p>
        `;
        
        // Run image captioning inference if model is loaded
        if (smolvlmPipeline) {
          statsDiv.innerHTML += '<p><strong>Running image captioning inference...</strong></p>';
          
          try {
            // Convert canvas to blob URL for Transformers.js
            const imageBlob = await new Promise<Blob>((resolveBlob, rejectBlob) => {
              canvas.toBlob((blob) => {
                if (blob) {
                  resolveBlob(blob);
                } else {
                  rejectBlob(new Error('Failed to convert canvas to blob'));
                }
              }, 'image/png');
            });
            
            const imageUrl = URL.createObjectURL(imageBlob);
            
            // Run inference with image captioning model using blob URL
            // For image-to-text pipeline, pass the image URL
            // Use Function.prototype.call to avoid type assertion
            const pipelineCall = Function.prototype.call.bind(smolvlmPipeline);
            const result: unknown = await pipelineCall(smolvlmPipeline, imageUrl);
            
            // Clean up blob URL
            URL.revokeObjectURL(imageUrl);
            
            // Display inference result with proper type checking
            let generatedText: string;
            if (Array.isArray(result) && result.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              const firstResult = result[0];
              if (typeof firstResult === 'object' && firstResult !== null && 'generated_text' in firstResult) {
                // Access generated_text property safely using Object.getOwnPropertyDescriptor
                const descriptor = Object.getOwnPropertyDescriptor(firstResult, 'generated_text');
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                const textValue = descriptor ? descriptor.value : undefined;
                generatedText = typeof textValue === 'string' ? textValue : JSON.stringify(result);
              } else {
                generatedText = JSON.stringify(result);
              }
            } else if (typeof result === 'string') {
              generatedText = result;
            } else {
              generatedText = JSON.stringify(result);
            }
            
            statsDiv.innerHTML += `
              <h3>Image Captioning Result</h3>
              <p>${generatedText}</p>
            `;
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            statsDiv.innerHTML += `<p style="color: red;">Image captioning error: ${errorMsg}</p>`;
          }
        }
        resolve();
      };
      
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load image'));
      };
      
      img.src = url;
    };
    
    fileReader.onerror = () => {
      reject(new Error('Failed to read file'));
    };
    
    fileReader.readAsArrayBuffer(file);
  });
}

function processText(text: string, output: HTMLPreElement): void {
  const module = wasmModule;
  if (!module) {
    throw new Error('WASM module not initialized');
  }
  
  // Normalize text
  const normalized = module.normalize_text(text);
  
  // Preprocess text (tokenize)
  const tokens = module.preprocess_text(normalized);
  
  // Display results
  output.textContent = `Original: ${text}\n\nNormalized: ${normalized}\n\nTokens (${tokens.length}): [${Array.from(tokens).slice(0, 20).join(', ')}${tokens.length > 20 ? '...' : ''}]`;
}

