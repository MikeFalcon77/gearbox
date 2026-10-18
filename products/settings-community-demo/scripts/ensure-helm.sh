#!/bin/sh
set -eu

# Private tool cache: no changes to the user's global Helm installation.
version=3.17.3
case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo 'Use this script from WSL or macOS.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo 'Unsupported Helm architecture.' >&2; exit 1 ;;
esac
tools_dir=${DEMO_TOOLS_DIR:-${HOME}/.cache/gearbox-demo/tools}
destination="$tools_dir/helm-v$version-$os-$arch"
if [ ! -x "$destination" ]; then
  download_dir="$tools_dir/downloads/helm-v$version-$os-$arch"
  mkdir -p "$download_dir"
  archive="helm-v$version-$os-$arch.tar.gz"
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 10 --max-time 120 \
    "https://get.helm.sh/$archive" -o "$download_dir/$archive"
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 10 --max-time 60 \
    "https://get.helm.sh/$archive.sha256sum" -o "$download_dir/checksum"
  (
    cd "$download_dir"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum --check checksum >&2
    else
      shasum -a 256 --check checksum >&2
    fi
  )
  tar -xzf "$download_dir/$archive" -C "$download_dir"
  cp "$download_dir/$os-$arch/helm" "$destination"
  chmod 755 "$destination"
fi
"$destination" version --short >&2
printf '%s\n' "$destination"
