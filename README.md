# Rust WebAssembly A* Pathfinding Demo

This is a port of an A* implementation by [Jacob Reichert](https://github.com/jacobdeichert/wasm-astar).

Check out the demo [here](https://sigma-wasm.onrender.com/)!

![demo gif](dist/demo.gif)

#### Where to Store Game State

Global scoped variables are not ideal of course, but for a small demo it shouldn't be a problem. One goal of mine was to keep as much logic as possible on the Rust side instead of in js land. I also didn't want to send the game state back and forth between js and Rust every tick since that seems like absolute overkill. With that said, it seemed like I must store the game state in a global Rust variable. After reading through the `rocket_wasm` source code, I copied their [global state pattern](https://github.com/aochagavia/rocket_wasm/blob/d0ca51beb9c7c351a1f0266206edfd553bf078d3/src/lib.rs#L23-L25).

~~~rust
lazy_static! {
    static ref WORLD_STATE: Mutex<WorldState> = Mutex::new(WorldState::new());
    static ref ENGINE_STATE: Mutex<EngineState> = Mutex::new(EngineState::new());
}
~~~

> [view src](https://github.com/jacobdeichert/wasm-astar/blob/cee849fa6ae54ba187e1a16556ce35ea1698b052/src/lib.rs#L44-L47)

However, this pattern ended up causing a few issues for me that I had to overcome...

#### Mutex Unlocking

With the game state stored as a mutex, I need to lock it each time I want to use it.

As you'll see in the snippet below, I ran into an issue where I accessed `WORLD_STATE` and then called another function which also accessed `WORLD_STATE` too. I ran into this issue the hard way... After the wasm loaded in the client, I'd get this amazingly descriptive error:

> "RuntimeError: unreachable executed"

After disabling some code here and there, I found out where this error was coming from... the mutex locks.

I then learned that mutexes unlock themselves when their scope lifetime ends. With that knowledge, I tried wrapping a part of the logic with curly braces `{ ... }` and put the `initial_draw()` call outside that scope. This worked! The `world` variable dies at the end of its scope and this allows `initial_draw()` to access the `WORLD_STATE` mutex.

Throughout my code, you'll see a bunch of spots where I add extra curly braces. One alternative solution is to pass `world` to each function. I started doing that in some places, but haven't cleaned up the rest yet.

~~~rust
#[no_mangle]
pub extern "C" fn init(debug: i32, render_interval_ms: i32) {
    // Requires block curlies so lifetime of world ends which causes unlock
    // and allows initial_draw() to gain control of the lock.
    // Otherwise, this generic client error occurs: "RuntimeError: unreachable executed"
    {
        let world = &mut WORLD_STATE.lock().unwrap();
        world.debug = if debug == 1 { true } else { false };
        // ...
    }
    initial_draw();
}
~~~

> [view src](https://github.com/jacobdeichert/wasm-astar/blob/cee849fa6ae54ba187e1a16556ce35ea1698b052/src/lib.rs#L56-L77)

#### Mutex Unlocking Part 2

So this one was a little trickier to find at first. When the js side called my Rust `init()` function, if it's in debug mode I wanted to do a slow `setInterval` tick instead of the normal `requestAnimationFrame`. The Rust side kicks off `start_interval_tick()` on the js side. Since the tick is really slow, I didn't have an initial render shown for x amount of seconds. So to get that initial render, I decided to do an immediate tick by calling the Rust `tick()` function.

Then, this wonderful error again:

> "RuntimeError: unreachable executed"

After some fiddly debugging, I realized what was going on. Rust called into js (`start_interval_tick()`) and js called back into Rust (`tick()`) all within the same call stack started from the Rust `init()` function. Since both `init()` and `tick()` code paths access `WORLD_STATE`, `init()` still owned the lock and `tick()` crashed because of that. After I understood that it was due to sharing the same call stack, that meant that `init()` was never finishing and therefor its `WORLD_STATE` reference never unlocked. I simply fixed it by doing an immediate `setTimeout` (0ms) to push that initial `tick()` call onto the end of the js event queue thus having its own call stack.


Here's the fixed version.

~~~js
js_start_interval_tick(ms) {
    isIntervalTick = true;
    // If I immediately call wasmModule.tick, the rust WORLD_STATE mutex
    // doesn't get unlocked and throws an error. So instead, we do an
    // immediate setTimeout so it occurs on the next stack frame.
    setTimeout(() => {
        return WASM_ASTAR.wasmModule.tick(performance.now());
    }, 0);
    setInterval(() => {
        return WASM_ASTAR.wasmModule.tick(performance.now());
    }, ms);
},
~~~

> [view src](https://github.com/jacobdeichert/wasm-astar/blob/cee849fa6ae54ba187e1a16556ce35ea1698b052/dist/main.js#L59-L71)

> After writing this post, I now have realized I could instead remove this immediate tick and do it on the Rust side.

#### Sending Text to JS Land

JS and wasm can only send ints and floats back and forth right now, no strings yet. However, sending strings was easier than I thought it would be. I stumbled across this post [Getting started with Rust/WebAssembly](https://maffydub.wordpress.com/2017/12/02/getting-started-with-rust-webassembly/) which describes how to decode the text from the wasm module's memory buffer when given a pointer and a length.

I haven't ran any performance tests on this solution yet, so keep in mind that sending text to js draw calls every frame could slow down rendering a bit, though it might not be much. If anyone has done performance tests on this, let me know!

Also, I don't yet know how to send strings from js to Rust but so far I have not had to. An obvious reason would be user input.

~~~js
const wasmReadStrFromMemory = (ptr, length) => {
  const buf = new Uint8Array(WASM_ASTAR.wasmModule.memory.buffer, ptr, length);
  return new TextDecoder('utf8').decode(buf);
};
~~~

> [view src](https://github.com/jacobdeichert/wasm-astar/blob/5089f7ec663938c7bdeb178c357e111621ce3551/dist/main.js#L156-L162)



## Building

### Local Development (Without Docker)

#### Quick Setup

Run the setup script to install all required dependencies:

```bash
./scripts/setup-local.sh
```

This will:
- Check for Rust, Node.js, and npm
- Install wasm-bindgen-cli if missing
- Install npm dependencies
- Set up the wasm32-unknown-unknown target

#### Manual Setup

If you prefer to set up manually:

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Add wasm32 target
rustup target add wasm32-unknown-unknown

# Install wasm-bindgen-cli
cargo install wasm-bindgen-cli --version 0.2.87

# Install wasm-opt (optional but recommended)
# On macOS: brew install binaryen
# On Debian/Ubuntu: sudo apt-get install binaryen
# On Alpine: apk add binaryen
# Or via npm: npm install -g wasm-opt

# Install npm dependencies
npm install
```

#### Development

Start the development server:

```bash
# Option 1: Use the dev script
./scripts/dev-local.sh

# Option 2: Use npm directly
npm run dev
```

#### Production Build

Build for production:

```bash
# Build WASM and frontend
npm run build

# Or build WASM only
npm run build:wasm

# Preview production build
npm run preview
```

### Docker Build

#### Build Docker Image

```bash
# Build the Docker image
npm run build:docker
# Or directly:
docker build -t sigma-wasm .
```

#### Run Docker Container

```bash
# Run the container
docker run -p 3000:80 sigma-wasm

# Access at http://localhost:3000
```

#### Docker Compose (Optional)

If you have `docker-compose.yml`:

```bash
docker-compose up
```

## Deployment

### Render.com Deployment

This project is configured for automatic deployment on Render.com using Docker.

#### Prerequisites

1. A Render.com account
2. A Git repository (GitHub, GitLab, or Bitbucket)
3. The repository connected to Render.com

#### Automatic Deployment

1. **Push your code to Git** - Ensure `render.yaml` is in the root directory
2. **Connect to Render** - In Render dashboard, create a new "Blueprint" service
3. **Render will automatically:**
   - Detect the `render.yaml` file
   - Build using the Dockerfile
   - Deploy the service
   - Set up auto-deploy from your Git repository

#### Manual Configuration

If you prefer to configure manually:

1. Create a new **Web Service** in Render
2. Connect your Git repository
3. Set the following:
   - **Environment**: Docker
   - **Dockerfile Path**: `./Dockerfile`
   - **Docker Context**: `.`
   - **Build Command**: (auto-detected from Dockerfile)
   - **Start Command**: (auto-detected from Dockerfile)

#### Environment Variables

Environment variables can be set in:
- `render.yaml` (for static values)
- Render.com dashboard (for secrets and dynamic values)

See `.env.example` for available environment variables.

#### Build Configuration

The `render.yaml` file includes:
- Build filters (only rebuild on relevant file changes)
- Health check configuration
- Auto-deploy settings
- Environment variables

### Other Deployment Options

#### Static File Hosting

After building with `npm run build`, the `dist/` directory contains static files that can be served by:
- Any static file server (nginx, Apache, etc.)
- CDN services (Cloudflare, AWS CloudFront, etc.)
- Static hosting (Netlify, Vercel, GitHub Pages, etc.)

```bash
# Build the project
npm run build

# The dist/ directory contains all static files
# Serve with any static file server:
npx serve dist
```

## Environment Variables

See `.env.example` for a template of available environment variables.

### Build-time Variables

- `NODE_ENV` - Set to `production` for production builds

### Runtime Variables

Currently, no runtime environment variables are required. Add them to `.env.example` and `render.yaml` as needed.

## Troubleshooting

### Build Issues

**Error: `cargo: command not found`**
- Install Rust: https://rustup.rs/
- Ensure Rust is in your PATH

**Error: `wasm-bindgen: command not found`**
- Install with: `cargo install wasm-bindgen-cli --version 0.2.87`
- Ensure `~/.cargo/bin` is in your PATH

**Error: `wasm-opt: command not found`**
- This is optional but recommended
- Install via package manager or npm (see setup instructions above)
- Build will still work without it, but WASM won't be optimized

**Docker build fails**
- Ensure Docker is running
- Check that all required files are present
- Review Docker build logs for specific errors

### Runtime Issues

**WASM module not loading**
- Check browser console for errors
- Ensure `pkg/` directory is accessible
- Verify wasm-bindgen output files are present

**404 errors for assets**
- Ensure Vite build completed successfully
- Check that `dist/` directory contains all files
- Verify nginx configuration (if using Docker)

### Render.com Issues

**Deployment fails**
- Check Render build logs
- Verify `render.yaml` syntax
- Ensure Dockerfile is valid
- Check that all required files are in the repository

**Service not starting**
- Check Render service logs
- Verify health check endpoint
- Ensure port 80 is exposed in Dockerfile

## Project Structure

```
sigma-wasm/
├── Dockerfile              # Multi-stage Docker build
├── .dockerignore           # Docker build exclusions
├── render.yaml             # Render.com configuration
├── .env.example            # Environment variables template
├── Cargo.toml              # Rust dependencies
├── package.json            # Node.js dependencies
├── vite.config.ts          # Vite configuration
├── tsconfig.json           # TypeScript configuration
├── scripts/
│   ├── build.sh            # WASM build script
│   ├── setup-local.sh      # Local setup script
│   └── dev-local.sh        # Local dev server script
├── src/
│   ├── lib.rs              # Rust main library
│   ├── main.ts             # TypeScript entry point
│   ├── types.ts             # TypeScript type definitions
│   ├── styles.css           # Styles
│   └── [rust modules]      # Rust source code
└── dist/                   # Production build output (gitignored)
```
