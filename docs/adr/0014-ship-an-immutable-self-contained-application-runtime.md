# Ship an immutable self-contained Application Runtime

The installed `Yulu.app` bundles its exact arm64 Node, Python, ffmpeg, production
modules, native addons, and Swift helpers, and never runs npm, pip, Homebrew, or
compilation after signing. Large optional models remain integrity-checked runtime
packs outside the App, while external Agents and calendar tools remain explicit
optional capabilities rather than startup dependencies.
