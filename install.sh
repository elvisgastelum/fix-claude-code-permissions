#!/usr/bin/env bash
# fix-claude-code installer.
#
# Install / update:  curl -fsSL https://raw.githubusercontent.com/elvisgastelum/fix-claude-code-permissions/main/install.sh | bash
# Uninstall:         curl -fsSL https://raw.githubusercontent.com/elvisgastelum/fix-claude-code-permissions/main/install.sh \
#                      | bash -s -- --uninstall
#
# Re-running the installer updates an existing install. `--uninstall` removes the checkout and
# the `fix-claude-code` command. Both only touch a checkout this installer can recognise as its
# own (a git root whose package.json is named fix-claude-code-permissions) and a launcher it
# wrote itself (it carries a marker line); anything else is left alone. An update is refused
# when the checkout has local changes.
#
# Only git and Node.js are needed on the target: dist/cli.mjs is committed, so nothing is
# installed or built here.
#
# Environment:
#   FIX_CLAUDE_CODE_HOME     checkout location  (default: $HOME/.local/share/fix-claude-code)
#                            absolute path; never / or $HOME itself
#   FIX_CLAUDE_CODE_REPO     git URL to clone   (default: https://github.com/elvisgastelum/fix-claude-code-permissions.git)
#   FIX_CLAUDE_CODE_REF      branch or tag      (default: main)
#   FIX_CLAUDE_CODE_BIN_DIR  launcher location (default: $HOME/.local/bin), absolute path
#
# All installer output goes to stderr.

set -euo pipefail

# Everything lives in main() so bash has read the whole script before any command runs;
# this matters under `curl | bash`, where the script itself arrives on stdin.
main() {
  # No colon in the expansions: a variable that is set but empty is an error, not the default.
  local repo="${FIX_CLAUDE_CODE_REPO-https://github.com/elvisgastelum/fix-claude-code-permissions.git}"
  local ref="${FIX_CLAUDE_CODE_REF-main}"
  local home_dir="${FIX_CLAUDE_CODE_HOME-$HOME/.local/share/fix-claude-code}"
  local bin_dir="${FIX_CLAUDE_CODE_BIN_DIR-$HOME/.local/bin}"
  local entry="" launcher=""
  local package_name='fix-claude-code-permissions'
  local marker='# fix-claude-code launcher (managed by install.sh)'

  local c_info="" c_warn="" c_err="" c_off=""
  if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
    c_info=$'\033[1;36m' c_warn=$'\033[1;33m' c_err=$'\033[1;31m' c_off=$'\033[0m'
  fi
  say() { printf '%s==>%s %s\n' "$c_info" "$c_off" "$*" >&2; }
  warn() { printf '%swarning:%s %s\n' "$c_warn" "$c_off" "$*" >&2; }
  die() {
    printf '%serror:%s %s\n' "$c_err" "$c_off" "$1" >&2
    [ -n "${2:-}" ] && printf '  fix: %s\n' "$2" >&2
    exit 1
  }
  usage() {
    cat >&2 <<'EOF'
Usage: install.sh [--uninstall] [--help]

  (no arguments)  install fix-claude-code, or update an existing install
  --uninstall     remove the checkout and the fix-claude-code command
  --help          show this help

Environment: FIX_CLAUDE_CODE_HOME, FIX_CLAUDE_CODE_REPO, FIX_CLAUDE_CODE_REF,
FIX_CLAUDE_CODE_BIN_DIR (see the top of this script).
EOF
  }

  local uninstall=0 arg
  for arg in "$@"; do
    case "$arg" in
      --uninstall) uninstall=1 ;;
      -h | --help)
        usage
        return 0
        ;;
      *)
        usage
        die "unknown argument: $arg" "run with --help to see what is supported."
        ;;
    esac
  done

  # The launcher embeds an absolute path, so both locations must be absolute, without `..`.
  # Trailing slashes are dropped so `/` and `$HOME/` are recognised below.
  clean_abs_path() {
    local name="$1" value="$2"
    [ -n "$value" ] || die "$name is empty." "unset it to use the default, or set an absolute path."
    case "$value" in
      /*) ;;
      *) die "$name must be an absolute path (got: $value)." "set $name to a path starting with /." ;;
    esac
    case "$value" in
      */.. | */../*) die "$name must not contain '..' (got: $value)." "use a path without '..' components." ;;
    esac
    while [ "$value" != / ] && [ "${value%/}" != "$value" ]; do value="${value%/}"; done
    printf '%s' "$value"
  }
  home_dir="$(clean_abs_path FIX_CLAUDE_CODE_HOME "$home_dir")"
  bin_dir="$(clean_abs_path FIX_CLAUDE_CODE_BIN_DIR "$bin_dir")"

  # Never use or delete the filesystem root or the user's home directory as the checkout.
  local user_home="${HOME:-}" real_home="" real_dir=""
  if [ -n "$user_home" ]; then
    while [ "$user_home" != / ] && [ "${user_home%/}" != "$user_home" ]; do user_home="${user_home%/}"; done
    real_home="$(cd "$user_home" 2>/dev/null && pwd -P)" || real_home=""
  fi
  real_dir="$(cd "$home_dir" 2>/dev/null && pwd -P)" || real_dir=""
  if [ "$home_dir" = / ] || [ "$real_dir" = / ] ||
    { [ -n "$user_home" ] && [ "$home_dir" = "$user_home" ]; } ||
    { [ -n "$real_home" ] && [ "$real_dir" = "$real_home" ]; }; then
    die "FIX_CLAUDE_CODE_HOME must not be / or your home directory (got: $home_dir)." \
      "set FIX_CLAUDE_CODE_HOME to a dedicated folder, such as \$HOME/.local/share/fix-claude-code."
  fi
  entry="$home_dir/dist/cli.mjs"
  launcher="$bin_dir/fix-claude-code"

  # True only for a checkout this installer owns: a directory that is itself a git root (not a
  # subfolder of someone else's repository) and whose package.json carries our package name.
  is_own_checkout() {
    local dir="$1" real top
    [ -d "$dir" ] || return 1
    real="$(cd "$dir" 2>/dev/null && pwd -P)" || return 1
    top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null </dev/null)" || return 1
    top="$(cd "$top" 2>/dev/null && pwd -P)" || return 1
    [ "$top" = "$real" ] || return 1
    [ -f "$dir/package.json" ] || return 1
    grep -Eq "^[[:space:]]*\"name\":[[:space:]]*\"$package_name\",?[[:space:]]*\$" "$dir/package.json" 2>/dev/null
  }

  # True when the launcher path is free, or is a regular file (never a symlink) that we wrote.
  can_manage_launcher() {
    if [ -L "$launcher" ]; then return 1; fi
    if [ ! -e "$launcher" ]; then return 0; fi
    [ -f "$launcher" ] && grep -qxF -- "$marker" "$launcher" 2>/dev/null
  }
  launcher_blocked_msg() {
    printf '%s exists and was not created by this installer' "$launcher"
  }

  if [ "$uninstall" = 1 ]; then
    if [ -e "$launcher" ] || [ -L "$launcher" ]; then
      if can_manage_launcher; then
        rm -f "$launcher"
      else
        warn "$(launcher_blocked_msg); leaving it untouched."
      fi
    fi
    if [ -e "$home_dir" ] || [ -L "$home_dir" ]; then
      if is_own_checkout "$home_dir"; then
        rm -rf "$home_dir"
      else
        warn "$home_dir is not a fix-claude-code checkout made by this installer (or git is missing); leaving it untouched."
      fi
    fi
    say "fix-claude-code uninstalled."
    return 0
  fi

  # Requirements: git and Node.js. dist/cli.mjs is prebuilt and self-contained.
  command -v git >/dev/null 2>&1 ||
    die "git is required but was not found." "install git: https://git-scm.com/downloads"
  command -v node >/dev/null 2>&1 ||
    die "Node.js is required but was not found." \
      "install Node.js (https://nodejs.org or your package manager), then re-run."

  # The repo and ref reach git as arguments: refuse anything that could be read as an option.
  case "$repo" in
    '' | -* | *[[:space:]]*)
      die "FIX_CLAUDE_CODE_REPO is empty, starts with '-' or contains whitespace." \
        "set it to a git URL or path, or unset it to use the default."
      ;;
  esac
  case "$ref" in
    '' | -* | *[[:space:]]*)
      die "FIX_CLAUDE_CODE_REF is empty, starts with '-' or contains whitespace." \
        "set it to a branch or tag name, or unset it to use the default."
      ;;
  esac

  # Refuse before touching anything when the launcher path belongs to something else.
  can_manage_launcher ||
    die "$(launcher_blocked_msg); not overwriting it." \
      "move it away or set FIX_CLAUDE_CODE_BIN_DIR to another folder, then re-run."

  # The minimum Node.js version lives in one place: the checkout's package.json `engines.node`.
  check_checkout() {
    local min
    min="$(cd "$home_dir" && node -p '(/[0-9]+\.[0-9]+\.[0-9]+/.exec((require("./package.json").engines || {}).node || "") || ["0.0.0"])[0]')" ||
      return 1
    if ! node -e '
      const parse = (v) => v.split(".").map(Number);
      const [a, b] = [parse(process.versions.node), parse(process.argv[1])];
      const cmp = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      process.exit(cmp >= 0 ? 0 : 1);
    ' "$min"; then
      printf '%serror:%s Node.js >= %s is required (found %s).\n  fix: %s\n' "$c_err" "$c_off" \
        "$min" "$(node --version)" "upgrade Node.js, then re-run." >&2
      return 1
    fi
    node "$entry" --version </dev/null >/dev/null || {
      printf '%serror:%s %s does not run.\n' "$c_err" "$c_off" "$entry" >&2
      return 1
    }
  }

  local prev="" created=0 status
  if [ -e "$home_dir" ] || [ -L "$home_dir" ]; then
    is_own_checkout "$home_dir" ||
      die "$home_dir exists but is not a fix-claude-code checkout made by this installer; leaving it untouched." \
        "set FIX_CLAUDE_CODE_HOME to another folder, or move that folder out of the way, then re-run."
    status="$(git -C "$home_dir" status --porcelain </dev/null)" ||
      die "could not read the state of $home_dir; the installed version is unchanged." \
        "check that git works in that folder, then re-run."
    [ -z "$status" ] ||
      die "$home_dir has local changes; not updating it." \
        "commit, stash or discard your changes there, or set FIX_CLAUDE_CODE_HOME to another folder, then re-run."
    prev="$(git -C "$home_dir" rev-parse HEAD </dev/null)" ||
      die "could not read the current version of $home_dir." "check that git works in that folder, then re-run."
    say "Updating $home_dir ($ref)"
    {
      git -C "$home_dir" fetch --quiet --depth 1 -- "$repo" "$ref" </dev/null >&2 &&
        git -C "$home_dir" checkout -q --detach FETCH_HEAD </dev/null >&2
    } ||
      die "could not update $home_dir to $ref; fetching or switching failed." \
        "check your network, the repository URL and the ref, then re-run."
  else
    say "Cloning $repo ($ref) into $home_dir"
    mkdir -p "$(dirname "$home_dir")"
    created=1
    git clone --quiet --depth 1 --branch "$ref" -- "$repo" "$home_dir" </dev/null >&2 || {
      # $home_dir did not exist before this run, so anything there was created by the clone.
      rm -rf "$home_dir"
      die "could not clone $repo ($ref)." "check the URL, the ref and your network, then re-run."
    }
  fi

  # Resolve symlinks and `.`/`..` once the directory exists: the launcher embeds this path.
  home_dir="$(cd "$home_dir" && pwd -P)" || die "could not enter $home_dir." "check its permissions, then re-run."
  entry="$home_dir/dist/cli.mjs"

  if ! check_checkout; then
    if [ "$created" = 1 ]; then
      rm -rf "$home_dir"
      die "installation failed; removed the checkout at $home_dir." \
        "fix the error above, then re-run the installer."
    fi
    warn "update failed; restoring the previous version ($prev)"
    if is_own_checkout "$home_dir" &&
      git -C "$home_dir" checkout -q --detach "$prev" </dev/null >&2 && check_checkout; then
      die "update to $ref failed; the previous version is still installed and working." \
        "fix the error above, then re-run the installer to update."
    fi
    die "update failed and the previous version does not run either." \
      "check $home_dir (try: git -C \"$home_dir\" checkout $prev), then re-run the installer."
  fi

  mkdir -p "$bin_dir"
  bin_dir="$(cd "$bin_dir" && pwd -P)" || die "could not enter $bin_dir." "check its permissions, then re-run."
  launcher="$bin_dir/fix-claude-code"
  can_manage_launcher ||
    die "$(launcher_blocked_msg); not overwriting it." \
      "move it away or set FIX_CLAUDE_CODE_BIN_DIR to another folder, then re-run."

  # Single-quote paths so quotes, `$` or backticks in them cannot break the launcher.
  sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
  local tmp
  tmp="$(mktemp "$bin_dir/.fix-claude-code.XXXXXX")" ||
    die "could not create a temporary file in $bin_dir." "check that the folder is writable, then re-run."
  {
    printf '#!/bin/sh\n%s\nexport FIX_CLAUDE_CODE_HOME=%s\nexec node %s "$@"\n' \
      "$marker" "$(sq "$home_dir")" "$(sq "$entry")" >"$tmp" &&
      chmod 755 "$tmp" &&
      can_manage_launcher &&
      mv -f "$tmp" "$launcher"
  } || {
    rm -f "$tmp"
    die "could not write $launcher." "check that $bin_dir is writable and $launcher is not in use, then re-run."
  }
  say "Installed $launcher"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir is not on your PATH; add: export PATH=\"$bin_dir:\$PATH\"" ;;
  esac
}

main "$@"
