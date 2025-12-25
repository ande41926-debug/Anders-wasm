import type { Layer, WasmAstar, WasmModuleAstar } from '../types';

// Lazy WASM import - only load when init() is called
// Using a getter function to defer the import until actually needed
let wasmInitFn: (() => Promise<unknown>) | null = null;
const getInitWasm = async (): Promise<unknown> => {
  if (!wasmInitFn) {
    // Import only when first called
    const wasmModule = await import('../../pkg/wasm_astar/wasm_astar.js');
    wasmInitFn = wasmModule.default;
  }
  return wasmInitFn();
};

// Type for wasm-bindgen exports
interface WasmBindgenExports {
  memory?: WebAssembly.Memory;
  wasm_init?: (debug: number, renderIntervalMs: number, windowWidth: number, windowHeight: number) => void;
  tick?: (elapsedTime: number) => void;
  key_down?: (keyCode: number) => void;
  key_up?: (keyCode: number) => void;
  mouse_move?: (x: number, y: number) => void;
}

const getLayerWrapper = (): HTMLElement => {
  const element = document.getElementById('layer_wrapper');
  if (!element) {
    throw new Error('layer_wrapper element not found');
  }
  return element;
};

const WASM_ASTAR: WasmAstar = {
  wasmModule: null,
  wasmModulePath: '../pkg/wasm_astar',
  debug: false,
  renderIntervalMs: 1000,
  layers: new Map(),
  layerWrapperEl: null,
};

export const init = async (): Promise<void> => {
  // Get layer wrapper element (lazy initialization - only when init is called)
  WASM_ASTAR.layerWrapperEl = getLayerWrapper();
  
  const { debug, renderIntervalMs } = WASM_ASTAR;
  
  // Set up imports for wasm-bindgen
  const wasmImports = getWasmImports();
  
  // Make functions available globally for wasm-bindgen
  const globalObj: { [key: string]: unknown } = globalThis;
  globalObj.js_random = (): number => wasmImports.js_random();
  globalObj.js_random_range = (min: number, max: number): number => wasmImports.js_random_range(min, max);
  globalObj.js_log = (): void => wasmImports.js_log();
  globalObj.js_request_tick = (): void => wasmImports.js_request_tick();
  globalObj.js_start_interval_tick = (ms: number): void => wasmImports.js_start_interval_tick(ms);
  globalObj.js_create_layer = (id: string, key: number): void => wasmImports.js_create_layer(id, key);
  globalObj.js_set_screen_size = (width: number, height: number, quality: number): void => wasmImports.js_set_screen_size(width, height, quality);
  globalObj.js_set_layer_size = (layerId: number, width: number, height: number, quality: number): void => wasmImports.js_set_layer_size(layerId, width, height, quality);
  globalObj.js_clear_screen = (layerId: number): void => wasmImports.js_clear_screen(layerId);
  globalObj.js_update = (): void => wasmImports.js_update();
  globalObj.js_draw_tile = (layerId: number, px: number, py: number, size: number, ch: number, cs: number, cl: number, ca: number): void => wasmImports.js_draw_tile(layerId, px, py, size, ch, cs, cl, ca);
  globalObj.js_draw_circle = (layerId: number, px: number, py: number, r: number, ch: number, cs: number, cl: number, ca: number): void => wasmImports.js_draw_circle(layerId, px, py, r, ch, cs, cl, ca);
  globalObj.js_draw_fps = (layerId: number, fps: number): void => wasmImports.js_draw_fps(layerId, fps);
  globalObj.js_path_count = (layerId: number, count: number): void => wasmImports.js_path_count(layerId, count);
  
  // Initialize wasm-bindgen (lazy load)
  const initResult = await getInitWasm();
  
  // Type guard to check if result has expected structure
  const wasmModuleExports: WasmBindgenExports = 
    typeof initResult === 'object' && initResult !== null
      ? initResult
      : {};
  
  // Type-safe assignment
  if (
    wasmModuleExports.memory &&
    wasmModuleExports.wasm_init &&
    wasmModuleExports.tick &&
    wasmModuleExports.key_down &&
    wasmModuleExports.key_up &&
    wasmModuleExports.mouse_move &&
    wasmModuleExports.memory instanceof WebAssembly.Memory &&
    typeof wasmModuleExports.wasm_init === 'function' &&
    typeof wasmModuleExports.tick === 'function' &&
    typeof wasmModuleExports.key_down === 'function' &&
    typeof wasmModuleExports.key_up === 'function' &&
    typeof wasmModuleExports.mouse_move === 'function'
  ) {
    const wasmModule: WasmModuleAstar = {
      memory: wasmModuleExports.memory,
      wasm_init: wasmModuleExports.wasm_init,
      tick: wasmModuleExports.tick,
      key_down: wasmModuleExports.key_down,
      key_up: wasmModuleExports.key_up,
      mouse_move: wasmModuleExports.mouse_move,
    };
    
    WASM_ASTAR.wasmModule = wasmModule;
    
    wasmModule.wasm_init(
      debug ? 1 : 0,
      renderIntervalMs,
      window.innerWidth,
      window.innerHeight
    );
  } else {
    throw new Error('WASM module does not have expected exports');
  }
  
  const layerWrapperEl = WASM_ASTAR.layerWrapperEl;
  if (!layerWrapperEl) {
    throw new Error('layer_wrapper element not found');
  }
  
  window.addEventListener('mousemove', (e: MouseEvent) => {
    const x = e.pageX - layerWrapperEl.offsetLeft;
    const y = e.pageY - layerWrapperEl.offsetTop;
    if (WASM_ASTAR.wasmModule) {
      WASM_ASTAR.wasmModule.mouse_move(x, y);
    }
  });
  
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (WASM_ASTAR.wasmModule) {
      WASM_ASTAR.wasmModule.key_down(e.keyCode);
    }
  });
  
  window.addEventListener('keyup', (e: KeyboardEvent) => {
    if (WASM_ASTAR.wasmModule) {
      WASM_ASTAR.wasmModule.key_up(e.keyCode);
    }
  });
  
  layerWrapperEl.addEventListener('touchend', () => {
    // Simulating spacebar for mobile support
    if (WASM_ASTAR.wasmModule) {
      WASM_ASTAR.wasmModule.key_down(32);
      requestAnimationFrame(() => {
        if (WASM_ASTAR.wasmModule) {
          WASM_ASTAR.wasmModule.key_up(32);
        }
      });
    }
  });
};

const getWasmImports = () => {
  let isIntervalTick = false;

  return {
    js_random(): number {
      return Math.random();
    },

    js_random_range(min: number, max: number): number {
      return Math.floor(Math.random() * (max + 1 - min)) + min;
    },

    js_log(): void {
      // Logging disabled per code requirements
    },

    js_request_tick(): void {
      if (isIntervalTick) return;
      requestAnimationFrame(() => {
        if (WASM_ASTAR.wasmModule) {
          WASM_ASTAR.wasmModule.tick(performance.now());
        }
      });
    },

    js_start_interval_tick(ms: number): void {
      isIntervalTick = true;
      requestAnimationFrame(() => {
        if (WASM_ASTAR.wasmModule) {
          WASM_ASTAR.wasmModule.tick(performance.now());
        }
      });
      const scheduleNext = (): void => {
        if (WASM_ASTAR.wasmModule && isIntervalTick) {
          const startTime = performance.now();
          requestAnimationFrame(() => {
            if (WASM_ASTAR.wasmModule && isIntervalTick) {
              const elapsed = performance.now() - startTime;
              if (elapsed >= ms) {
                WASM_ASTAR.wasmModule.tick(performance.now());
                scheduleNext();
              } else {
                scheduleNext();
              }
            }
          });
        }
      };
      scheduleNext();
    },

        js_create_layer(id: string, key: number): void {
          const wrapperEl = WASM_ASTAR.layerWrapperEl;
          if (!wrapperEl) {
            throw new Error('layer_wrapper element not found');
          }
          const canvasElement = document.createElement('canvas');
          const canvas = wrapperEl.appendChild(canvasElement);
      if (!(canvas instanceof HTMLCanvasElement)) {
        throw new Error('Failed to create canvas element');
      }
      canvas.id = id;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to get 2d context from canvas');
      }

      const layer: Layer = {
        ctx,
        canvas,
        setSize(width: number, height: number, quality: number): void {
          canvas.width = width;
          canvas.height = height;
          canvas.style.width = `${width / quality}px`;
          canvas.style.height = `${height / quality}px`;
        },
        clearScreen(): void {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        },
        drawRect(px: number, py: number, sx: number, sy: number, ch: number, cs: number, cl: number, ca: number): void {
          ctx.fillStyle = `hsla(${ch}, ${cs}%, ${cl}%, ${ca})`;
          ctx.fillRect(px, py, sx, sy);
        },
        drawCircle(px: number, py: number, r: number, ch: number, cs: number, cl: number, ca: number): void {
          ctx.fillStyle = `hsla(${ch}, ${cs}%, ${cl}%, ${ca})`;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2, true);
          ctx.closePath();
          ctx.fill();
        },
        drawText(text: string, fontSize: number, px: number, py: number): void {
          ctx.fillStyle = '#fff';
          ctx.font = `${fontSize}px Monaco, Consolas, Courier, monospace`;
          ctx.fillText(text, px, py);
        },
      };

      WASM_ASTAR.layers.set(key, layer);
    },

    js_set_screen_size(width: number, height: number, quality: number): void {
      const wrapper = WASM_ASTAR.layerWrapperEl;
      if (wrapper) {
        wrapper.style.width = `${width / quality}px`;
        wrapper.style.height = `${height / quality}px`;
      }
    },

    js_set_layer_size(layerId: number, width: number, height: number, quality: number): void {
      const layer = WASM_ASTAR.layers.get(layerId);
      if (layer) {
        layer.setSize(width, height, quality);
      }
    },

    js_clear_screen(layerId: number): void {
      const layer = WASM_ASTAR.layers.get(layerId);
      if (layer) {
        layer.clearScreen();
      }
    },

    js_update(): void {
      // For minimal necessary client updates
    },

    js_draw_tile(layerId: number, px: number, py: number, size: number, ch: number, cs: number, cl: number, ca: number): void {
      const layer = WASM_ASTAR.layers.get(layerId);
      if (layer) {
        layer.drawRect(px, py, size, size, ch, cs, cl, ca);
      }
    },

    js_draw_circle(layerId: number, px: number, py: number, r: number, ch: number, cs: number, cl: number, ca: number): void {
      const layer = WASM_ASTAR.layers.get(layerId);
      if (layer) {
        layer.drawCircle(px, py, r, ch, cs, cl, ca);
      }
    },

    js_draw_fps(layerId: number, fps: number): void {
      const layer = WASM_ASTAR.layers.get(layerId);
      if (layer) {
        layer.drawText(`fps: ${Math.round(fps)}`, 35, 5, 45);
      }
    },

    js_path_count(layerId: number, count: number): void {
      const layer = WASM_ASTAR.layers.get(layerId);
      if (layer) {
        layer.drawText(`path: ${count}`, 35, 5, 95);
      }
    },
  };
};

