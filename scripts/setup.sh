#!/usr/bin/env bash
# One-shot dependency setup, the single source of truth shared by local
# developers and CI: the pinned toolchain and tools, sibling repositories
# checked out under .deps/ at pinned commits, and the npm trees the Node
# host needs. Idempotent; safe to re-run.
#
# Environment:
#   SKIP_NODE=1          skip the npm installs
#   WASM_TOOLS_VERSION   version of wasm-tools to install (default below)
#   JUST_VERSION         version of just to install (default below)
#   WAC_VERSION          version of wac-cli to install (default below)
set -euo pipefail
cd "$(dirname "$0")/.."

WASM_TOOLS_VERSION="${WASM_TOOLS_VERSION:-1.247.0}"
JUST_VERSION="${JUST_VERSION:-1.54.0}"
WAC_VERSION="${WAC_VERSION:-0.10.1}"

WEBRTC_REPO=https://github.com/polymorph-components/polymorph-webrtc-datachannels.git
WEBRTC_PIN=13ddd6b4289e2503cb41fa7680758f2e3ddb08a8
WEBCRYPTO_REPO=https://github.com/polymorph-components/polymorph-webcrypto.git
WEBCRYPTO_PIN=61fbd02c55141a1c0d76eb524e7af4bb9488fc31
WEBSOCKET_REPO=https://github.com/polymorph-components/polymorph-websocket.git
WEBSOCKET_PIN=2000f548c92dd0c60c270ec94e9586dd11b78c33
IROH_REPO=https://github.com/n0-computer/iroh.git
IROH_PIN=816dd70c056b813dcb5cbfb6a9a15e12d04b72b1 # v1.0.3
TLS_REPO=https://github.com/polymorph-components/polymorph-tls.git
TLS_PIN=e43cad46625b049c1037cc734114457e1ae2cac1
# The jco fork: the P3/JSPI transpiler with the async fixes this
# repository needs (lann/jco all-fixes plus the first two commits of
# PR #27; the PR's concurrency fixes are excluded until the exec-model
# probes pass with them — see the PR's verification notes). host-jco
# consumes packages/jco-transpile as a file: dependency, so this
# checkout must be built before host-jco's npm install resolves
# against it.
JCO_REPO=https://github.com/lann/jco.git
JCO_PIN=30186b2b1ee0ce7ef9703844b41b0af2456a5476 # PR #27, ponyfill fix

log() { printf '\n==> %s\n' "$1"; }

log "Installing pinned Rust toolchain and wasm targets (rust-toolchain.toml)"
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install

# cargo-binstall is itself pinned: the release asset for this platform is
# downloaded directly and verified against scripts/cargo-binstall.sha256
# before it runs — never a floating bootstrap script. Bumping the version
# means re-recording those digests deliberately.
BINSTALL_VERSION="1.21.1"

sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

install_binstall() {
    local asset
    case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) asset="cargo-binstall-x86_64-unknown-linux-musl.tgz" ;;
    Linux-aarch64) asset="cargo-binstall-aarch64-unknown-linux-musl.tgz" ;;
    Darwin-*) asset="cargo-binstall-universal-apple-darwin.zip" ;;
    *) asset="" ;;
    esac
    if [ -z "$asset" ]; then
        echo "setup: no pinned cargo-binstall asset for $(uname -s)/$(uname -m); building from crates.io (registry checksums)" >&2
        cargo install cargo-binstall --locked --version "$BINSTALL_VERSION"
        return
    fi

    local want
    want="$(grep -v '^#' scripts/cargo-binstall.sha256 | awk -v a="$asset" '$2 == a { print $1 }')"
    if [ -z "$want" ]; then
        echo "setup: scripts/cargo-binstall.sha256 pins no digest for ${asset}; record it deliberately" >&2
        exit 1
    fi

    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL --proto '=https' --tlsv1.2 -o "${tmp}/${asset}" \
        "https://github.com/cargo-bins/cargo-binstall/releases/download/v${BINSTALL_VERSION}/${asset}"

    local got
    got="$(sha256_of "${tmp}/${asset}")"
    if [ "$got" != "$want" ]; then
        rm -rf "$tmp"
        cat >&2 <<EOF
setup: ${asset} does not match the digest pinned for cargo-binstall ${BINSTALL_VERSION}.
  expected ${want}
  actual   ${got}

The download has been removed. Either the published asset was replaced,
the pin is stale, or the download was tampered with. Re-record the
digests deliberately after establishing why they changed.
EOF
        exit 1
    fi

    mkdir -p "$HOME/.cargo/bin"
    case "$asset" in
    *.tgz) tar -xzf "${tmp}/${asset}" -C "$HOME/.cargo/bin" cargo-binstall ;;
    *.zip) unzip -q -o "${tmp}/${asset}" cargo-binstall -d "$HOME/.cargo/bin" ;;
    esac
    rm -rf "$tmp"
}

log "Ensuring cargo-binstall ${BINSTALL_VERSION} is installed"
if command -v cargo-binstall >/dev/null 2>&1; then
    echo "cargo-binstall already present: $(cargo-binstall -V)"
else
    install_binstall
fi

# Install a crate binary with cargo-binstall (prebuilt artifact when one
# exists, `cargo install` fallback otherwise). Only reached when the
# `command -v` guard fails; `--force` covers a restored cargo cache that has
# the install metadata without the binary.
binstall() {
    cargo binstall --no-confirm --locked --force "$1"
}

log "Ensuring wasm-tools ${WASM_TOOLS_VERSION} is installed"
if command -v wasm-tools >/dev/null 2>&1; then
    echo "wasm-tools already present: $(wasm-tools --version)"
else
    binstall "wasm-tools@${WASM_TOOLS_VERSION}"
fi

log "Ensuring just ${JUST_VERSION} is installed"
# Version-checked, not presence-checked: the justfiles carry a hard
# version floor (module recipes as dependencies, just 1.42+), so a stale
# just on PATH is replaced rather than tolerated.
if command -v just >/dev/null 2>&1 && just --version 2>/dev/null | grep -qF "${JUST_VERSION}"; then
    echo "just already present: $(just --version)"
else
    binstall "just@${JUST_VERSION}"
    hash -r
    just --version 2>/dev/null | grep -qF "${JUST_VERSION}" || {
        echo "setup: a different just still shadows ${JUST_VERSION} on PATH: $(command -v just) ($(just --version))" >&2
        exit 1
    }
fi

log "Ensuring wac ${WAC_VERSION} is installed"
if command -v wac >/dev/null 2>&1; then
    echo "wac already present: $(wac --version)"
else
    binstall "wac-cli@${WAC_VERSION}"
fi

# Check out `repo` at `pin` under .deps/`name`, cloning or fetching as
# needed. An existing checkout at the pin is left untouched.
dep() {
    local name=$1 repo=$2 pin=$3
    local dir=.deps/$name
    if [ ! -e "$dir" ]; then
        git clone "$repo" "$dir"
    fi
    if [ "$(git -C "$dir" rev-parse HEAD)" != "$pin" ]; then
        git -C "$dir" fetch origin "$pin" 2>/dev/null || git -C "$dir" fetch origin
        git -C "$dir" checkout "$pin"
    fi
}

log "Checking out pinned sibling and upstream repositories under .deps/"
mkdir -p .deps
dep webrtc "$WEBRTC_REPO" "$WEBRTC_PIN"
dep webcrypto "$WEBCRYPTO_REPO" "$WEBCRYPTO_PIN"
dep websocket "$WEBSOCKET_REPO" "$WEBSOCKET_PIN"
# Upstream iroh: the stock relay server the demo runs against.
dep iroh "$IROH_REPO" "$IROH_PIN"
dep tls "$TLS_REPO" "$TLS_PIN"
dep jco "$JCO_REPO" "$JCO_PIN"

if [ "${SKIP_NODE:-}" != "1" ]; then
    log "Building the jco toolchain from the pinned fork"
    # The stamp records which pin the build products belong to; a moved
    # pin invalidates them even though the files still exist.
    JCO_STAMP=.deps/jco/.component-iroh-built-at
    if [ -f "$JCO_STAMP" ] && [ "$(cat "$JCO_STAMP")" = "$JCO_PIN" ]; then
        echo "jco toolchain already built at $JCO_PIN"
    else
        PATH="$(npm prefix -g)/bin:$PATH"
        if ! command -v pnpm >/dev/null 2>&1; then
            npm install -g pnpm
        fi
        (
            cd .deps/jco
            # The fork pins its own toolchain (stable + wasm32-wasip1)
            # in its rust-toolchain.toml.
            rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install
            pnpm install --frozen-lockfile
            cargo xtask build debug
            pnpm run --filter @bytecodealliance/jco-transpile build
            # The cargo intermediates dwarf the build products; drop them
            # so caching .deps/jco stays cheap.
            rm -rf target
        )
        echo "$JCO_PIN" > "$JCO_STAMP"
    fi

    log "Installing npm dependencies"
    # The webrtc sibling's jco host module resolves node-datachannel from
    # its own package directory.
    npm install --prefix .deps/webrtc/jco-impl
    npm install --prefix host-jco
fi

log "setup complete"
