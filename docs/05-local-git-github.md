# Local-only Git & GitHub CLI setup

Hive keeps **all** git identity and GitHub authentication scoped to this
project folder. Nothing touches your machine-wide config. This matters because
you may work on repos under different identities on the same machine, and a
leaked global token is a much wider blast radius than a project-scoped one.

## The rule

| Concern | Global (never) | Local (always) |
|---|---|---|
| Commit identity | `git config --global user.*` | `git config --local user.*` |
| GitHub auth | `~/.config/gh` / `%AppData%\GitHub CLI` | `./.gh-config/` via `GH_CONFIG_DIR` |

`.gh-config/` is gitignored. It holds a real OAuth token — treat it like a
secret and never commit it.

## 1. Confirm global state is clean

```bash
git config --global --get user.name    # should print nothing
git config --global --get user.email   # should print nothing
gh auth status                         # should say "not logged into any GitHub hosts"
```

If any of them return a value and you want them gone:

```bash
git config --global --unset user.name
git config --global --unset user.email
gh auth logout --hostname github.com
```

> Only run the unset/logout commands if you actually want global identity
> removed — they affect every other repo on this machine.

## 2. Point `GH_CONFIG_DIR` at the project

This is a per-shell environment variable. It must be set **in every shell**
where you run `gh` for this project, before the `gh` command.

**PowerShell (Windows)**
```powershell
$env:GH_CONFIG_DIR = "$PWD\.gh-config"
```

**cmd.exe (Windows)**
```cmd
set GH_CONFIG_DIR=%CD%\.gh-config
```

**bash / zsh (macOS, Linux, Git Bash)**
```bash
export GH_CONFIG_DIR="$PWD/.gh-config"
```

**Cross-platform, auto-detecting (bash-compatible):**
```bash
export GH_CONFIG_DIR="$(pwd)/.gh-config"
```
`$(pwd)` works identically on macOS, Linux and Git Bash on Windows; only
native PowerShell/cmd need the variants above.

Verify it took effect — the path should be inside `d:\hive`:
```bash
gh config list        # reads from .gh-config once the var is set
```

### Making it automatic
Two options so you don't have to remember:
- **direnv** (macOS/Linux): add `export GH_CONFIG_DIR="$PWD/.gh-config"` to a
  `.envrc`, then `direnv allow`. Add `.envrc` to `.gitignore` if it ever holds
  anything secret.
- **Claude Code**: already handled — `.claude/settings.json` sets
  `env.GH_CONFIG_DIR` to `.gh-config` for tool calls in this project.

## 3. Log in (interactive — you run this yourself)

```bash
gh auth login
```

Answer: `GitHub.com` → `HTTPS` → `Yes` (authenticate git with gh credentials)
→ `Login with a web browser` → copy the one-time code → paste in the browser.

Confirm the config landed in the project, not your home directory:
```bash
gh auth status
ls .gh-config          # hosts.yml and config.yml should exist here
```

### Where the token actually lives

On Windows, `gh auth status` reports `(keyring)` — the token is stored in the
Windows Credential Manager, **not** in `.gh-config/hosts.yml`. That file only
records the username and git protocol.

This is the better default: the token is encrypted by the OS rather than
sitting in plaintext on disk. The honest caveat is that a keyring entry is
keyed by hostname and scoped to your Windows user, not to this folder — so it
is not *strictly* project-local the way `.gh-config/` is. With a single GitHub
account that distinction has no practical effect.

`gh auth login --insecure-storage` would force the token into `hosts.yml` for
true file-locality, at the cost of a plaintext token on disk. Not recommended.

### Global hooks apply here too

This machine sets `core.hooksPath` globally to `~/.githooks`, which includes a
`commit-msg` hook that strips Claude/Anthropic `Co-Authored-By` trailers and
chains to any repo-local hook. That is intentional and reinforces the
attribution rule in `CLAUDE.md` — but it is machine-global state, so a fresh
clone on another machine will not have it. Do not treat it as the project's
only guard.

## 4. Set the local commit identity

```bash
git config --local user.name  "Your Name"
git config --local user.email "you@example.com"
```

Verify — the second command should show the `.git/config` path, not a global one:
```bash
git config --local --list | grep user
git config --show-origin user.email
```

## 5. Sanity check before the first push

```bash
git config --global --get user.email   # still empty
git config --local  --get user.email   # your project identity
gh auth status                          # logged in, from .gh-config
git check-ignore -v .gh-config          # confirms it is ignored
```

## Troubleshooting

- **`gh` still uses the global account** — `GH_CONFIG_DIR` wasn't set in *this*
  shell. It does not persist across terminals unless you use direnv or add it
  to your profile.
- **Commits show the wrong author** — you already committed. Fix future
  commits with step 4; rewrite past ones with
  `git commit --amend --reset-author` (only for unpushed commits).
- **`.gh-config` showed up in `git status`** — the `.gitignore` entry is
  missing or the folder was force-added. Run `git rm -r --cached .gh-config`.
