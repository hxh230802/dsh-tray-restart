# dsh-tray-restart

Adds **“重启 DeepSeek Harness”** (fixed Chinese label) to DeepSeek Harness Desktop’s existing menus:

- the system-tray context menu (`Open` / **`重启 DeepSeek Harness`** / `Quit`);
- the application menu (Windows title-bar “Application”, macOS menu bar), where the item normally exists only in development builds.

The action is the app’s own `app.relaunch()` + `quitWithoutConfirmation()`, so it shuts the Host down through the normal quit path and then relaunches the app.

## How it works

The tray and application menus live in the Electron main process (`resources/app.asar` → `lib/main.js`). DSH plugins run in the Host child process and have no runtime hook for those native menus. On every Host start this plugin therefore patches `lib/main.js` in place:

1. skip when the `dsh-tray-restart:menu:v2` marker is present;
2. apply two text edits, remove an equal number of bytes of comments, and pad with spaces so the file keeps its **exact byte length** (asar offsets are fixed);
3. run `node --check` on the patched ESM; on failure `app.asar` is left untouched;
4. back up the original `main.js`, write the patch, update the per-file SHA256 in the asar header, read it back and verify;
5. **restart DSH once** — the running main process still has the old code loaded.

An app update replaces `app.asar`; the next launch patches the new file automatically.

## Plugin page

The plugin page in the plugin manager renders a `plugins.bundle.config` card with:

- patch state, desktop app version, patch version;
- `app.asar`, backup directory and log path;
- **Re-check**, **Apply now** and **Restore original menu** actions.

Restoring writes the backup back and pauses automatic patching, so the next launch does not immediately re-apply it; **Apply now** resumes. A written patch still needs one DSH restart to take effect.

## Install

Install from GitHub with the DSH plugin manager:

```
github:hxh230802/dsh-tray-restart
```

or:

```json
{ "action": "install_bundle", "target": "github:hxh230802/dsh-tray-restart" }
```

Manual one-shot patch (also useful for debugging):

```powershell
node scripts/apply.mjs
```

## Restore

Backups:

```
%USERPROFILE%\.dsh\dsh-tray-restart\backup\main.original.js
%USERPROFILE%\.dsh\dsh-tray-restart\backup\manifest.json
```

```powershell
node scripts/restore.mjs
```

The restore refuses when the current `main.js` is not the exact copy this plugin wrote (e.g. after an app update).

If the asar header itself is damaged and the normal restore cannot parse it:

```powershell
node scripts/emergency-restore.mjs
```

## Config

```yaml
- id: dsh-tray-restart
  config:
    enabled: true
    dryRun: false       # generate + syntax-check only, never write app.asar
    verifySyntax: true
    asarPath: ''        # debug / non-standard installs
```

## Notes

- Verified against desktop `0.2.0-rc.2`. If a later build changes the menu source, the plugin logs `unsupported` and leaves `app.asar` untouched.
- This modifies installed application files, not an official API. A syntax check and a backup are taken before writing. If the app stops starting, run `node scripts/restore.mjs`.
- Restarting interrupts running tasks; there is no extra confirmation, matching the official development-build menu item.
