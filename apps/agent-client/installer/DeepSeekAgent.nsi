; DeepSeekAgent NSIS installer
; Packages the verified deployment at D:\DeepSeekAgent into a single setup file.
; Excluded: logs/, resources/_rollback_e30, stray resources/app, and the
; node24-dependent DeepSeekAgent.cmd/.vbs/run-agent.js (node24 was deleted).
; A node-free launcher (installer/DeepSeekAgent.cmd) is shipped instead.
; NOTE: resources\node.exe IS shipped (see the resources section below) -- the dsh web
; server cannot run on Electron's builtin Node (HMR needs a real --expose-internals).

!include "MUI2.nsh"

!define APPNAME "DeepSeekAgent"
!define APPVERSION "0.1.0"
!define PUBLISHER "DeepSeek"
; Overridable so a build can be staged to a scratch path first, then promoted:
;   makensis /DSRC=... /DOUTFILE=... installer\DeepSeekAgent.nsi
!ifndef SRC
  !define SRC "D:\DeepSeekAgent"
!endif
!ifndef OUTFILE
  !define OUTFILE "D:\WorkSpace\deepseek-harness-master\apps\agent-client\release\DeepSeekAgent-Setup-0.1.0.exe"
!endif

; Payload exclusion masks. Everything listed here is provably unused at runtime; the
; selection was derived by profiling the shipped runtime (see
; apps/agent-client/scripts/_opt_payload_predict.mjs, which mirrors this list 1:1 --
; keep the two in sync).
;
; Measured on the 2026-09-11 deployment tree:
;   before 145,640 entries / 1574 MB  ->  after 23,777 entries / 601 MB
;   (junction blow-up removed separately by scripts/_opt_flatten_deploy.mjs)
;
; Groups:
;   * test fixtures           12.4k files / 115MB  (upstream npm + vendored plugins)
;   * *.d.ts / *.map / *.tsbuildinfo / *.pdb         type decls, sourcemaps, build
;                                                    info, debug symbols: none read
;                                                    by a running Node process
;   * README/CHANGELOG/...   package prose only. NOTE: the older masks README* /
;                              CHANGELOG* / HISTORY* were WRONG for the same reason as
;                              *.spec.* above -- NSIS masks are case-insensitive and '*'
;                              crosses dots, so "CHANGELOG*" also deleted changelog.js and
;                              "HISTORY*" deleted the whole @lexical/history directory.
;                              Measured 2026-09-15 on a real install: 14 non-prose files
;                              were dropped, and dsh-market's lib/routes.js importing the
;                              missing ./changelog.js aborted the whole plugin tree
;                              (dsh web exit code 1 -> the exe hung forever on the
;                              "starting DSH Web workbench" splash). List prose by exact
;                              name + extension.
;                              Do NOT re-introduce bare names (README / HISTORY): a bare
;                              mask also matches DIRECTORIES with that name, which is how
;                              @lexical/history disappeared. The few extension-less prose
;                              files left behind (pako/lib/zlib/README, ...) are a few KB.
;   * node-pty-{darwin,linux}* / node-pty-win32-arm64  prebuilt natives for other
;                                                    platforms; this build is win32-x64
;   * .github / .vscode        repo metadata
;   * .dsh-*                   pnpm-style "real storage" dirs for workspace packages.
;                              The matching canonical-name junction is expanded into a
;                              real directory by File /r, so keeping both doubles the
;                              whole @deepseek-ai tree (~85MB of pure duplication).
;
; Usage: File /r ${PAYLOAD_EXCL} "path\*"
; NOTE: do NOT use the broad masks *.spec.* / *.test.* / README* / CHANGELOG* -- NSIS
; '*' also matches dots and masks are case-insensitive, so they sweep up unrelated files
; that merely start with the same letters (changelog.js, readme.js, @lexical/history).
; List one exact name or per-extension mask instead.
; IMPORTANT: this whole .nsi file must stay pure ASCII (NSIS reads it as ACP and
; aborts with "Bad text encoding" otherwise).
; 2026-09-17: added *.ts / *.tsx / *.cts / *.mts / *.md / *.markdown / *.rst.
; Evidence: dsh web starts via `node --expose-internals <dsh>/lib/bin.js` (pure CJS
; build output). A full cordis boot probe measured "0 .ts/.md files loaded during
; startup", i.e. the runtime only needs compiled lib/*.js + config JSON; TypeScript
; sources and Markdown docs are dead weight. Dropping them takes dsh-runtime from
; 290.2MB down to 167.6MB (36.0MB saved across the three PAYLOAD_EXCL subtrees),
; with zero functional loss.
!define PAYLOAD_EXCL '/x "*.spec.ts" /x "*.spec.tsx" /x "*.spec.js" /x "*.spec.mjs" /x "*.spec.cjs" /x "*.test.ts" /x "*.test.tsx" /x "*.test.js" /x "*.test.mjs" /x "*.test.cjs" /x "tests" /x "__tests__" /x "*.d.ts" /x "*.ts" /x "*.tsx" /x "*.cts" /x "*.mts" /x "*.md" /x "*.markdown" /x "*.rst" /x "*.map" /x "*.tsbuildinfo" /x "*.pdb" /x "README.md" /x "README.txt" /x "README.markdown" /x "README.rst" /x "CHANGELOG.md" /x "CHANGELOG.txt" /x "CHANGELOG.markdown" /x "CHANGELOG.rst" /x "CONTRIBUTING.md" /x "CONTRIBUTING.txt" /x "AUTHORS.md" /x "AUTHORS.txt" /x "HISTORY.md" /x "HISTORY.txt" /x "node-pty-darwin-arm64" /x "node-pty-darwin-x64" /x "node-pty-linux-arm64" /x "node-pty-linux-x64" /x "node-pty-win32-arm64" /x ".github" /x ".vscode" /x ".dsh-*"'

; Electron locale paks. The stock locales/ dir is 48MB across 55 languages; a zh-CN
; build needs the app language plus the en-US fallback. Listed explicitly instead of
; File /r so nothing else sneaks back in.
!define LOCALE_KEEP_1 "zh-CN.pak"
!define LOCALE_KEEP_2 "en-US.pak"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\${APPNAME}"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Main" SecMain
  SetOutPath "$INSTDIR"
  File "${SRC}\DeepSeekAgent.exe"
  File "${SRC}\LICENSE"
  File "${SRC}\LICENSE.electron.txt"
  File "${SRC}\LICENSES.chromium.html"
  File "${SRC}\chrome_100_percent.pak"
  File "${SRC}\chrome_200_percent.pak"
  File "${SRC}\resources.pak"
  File "${SRC}\d3dcompiler_47.dll"
  File "${SRC}\dxcompiler.dll"
  File "${SRC}\dxil.dll"
  File "${SRC}\ffmpeg.dll"
  File "${SRC}\icudtl.dat"
  File "${SRC}\libEGL.dll"
  File "${SRC}\libGLESv2.dll"
  File "${SRC}\snapshot_blob.bin"
  File "${SRC}\v8_context_snapshot.bin"
  File "${SRC}\version"
  File "${SRC}\vk_swiftshader.dll"
  File "${SRC}\vk_swiftshader_icd.json"
  File "${SRC}\vulkan-1.dll"
  File "D:\WorkSpace\deepseek-harness-master\apps\agent-client\installer\DeepSeekAgent.cmd"

  SetOutPath "$INSTDIR\locales"
  File "${SRC}\locales\${LOCALE_KEEP_1}"
  File "${SRC}\locales\${LOCALE_KEEP_2}"

  SetOutPath "$INSTDIR\resources"
  File "${SRC}\resources\app.asar"
  ; Bundled standalone Node runtime. The Electron builtin Node cannot run the dsh web
  ; server: with ELECTRON_RUN_AS_NODE=1 it does not expose the ESM internal loader that
  ; @cordisjs/plugin-hmr requires, so dsh web dies with
  ; "--expose-internals is required for HMR service" and the app hangs on the
  ; "starting DSH Web workbench" splash. main.cjs prefers this binary over the builtin.
  File "${SRC}\resources\node.exe"

  SetOutPath "$INSTDIR\resources\app.asar.unpacked"
  File /r ${PAYLOAD_EXCL} "${SRC}\resources\app.asar.unpacked\*"

  SetOutPath "$INSTDIR\resources\apps"
  File /r ${PAYLOAD_EXCL} "${SRC}\resources\apps\*"

  SetOutPath "$INSTDIR\resources\dsh-runtime"
  File /r ${PAYLOAD_EXCL} "${SRC}\resources\dsh-runtime\*"

  ; /x "node_modules" here is deliberate and scoped to this subtree:
  ;   - <extensions>\node_modules is the shared resolver fallback that the app builds
  ;     on first launch (ensureExtensionsModuleFallback); shipping it would expand the
  ;     whole runtime node_modules a second time (+200MB).
  ;   - each plugin's own node_modules held only junctions into the runtime (already
  ;     stripped by scripts/_opt_flatten_deploy.mjs) plus two real copies that the
  ;     shared fallback now provides.
  SetOutPath "$INSTDIR\resources\packages"
  File /r ${PAYLOAD_EXCL} /x "node_modules" "${SRC}\resources\packages\*"

  ; Unpacked Chrome extension for the dsh-bridge-browser flow. Not a DSH plugin
  ; (it lives outside resources\packages so readCommunityPlugins never scans it);
  ; shipping it here means a fresh install already has the extension on disk for
  ; chrome://extensions -> "Load unpacked".
  SetOutPath "$INSTDIR\resources\browser-extension"
  File /r "${SRC}\resources\browser-extension\*"

  ; Warm-up: dsh web's first cold boot is dominated by AV real-time scanning of the
  ; runtime tree (~35k .js/.json files) plus symlink resolution through the 754-link
  ; ext-fallback layer. Measured 2026-09-18 on a real machine with Huorong AV:
  ;   cold first boot  ~19.7 s      warm boot  ~5.4-6.3 s      delta = ~14 s
  ; The `--warmup` mode now pre-reads every runtime file (prewarmTree, ~40 s, 35,582
  ; files / 67 MB) and then boots dsh web once, so the user's first double-click is
  ; already a warm start. Measured saving: 16.1 s off the dsh-pocket -> token window.
  ;
  ; IMPORTANT: pass the flag via the DSH_WARMUP env var, NOT as a CLI argument.
  ; Electron parses argv itself and rejects an unknown switch with
  ;   "DeepSeekAgent.exe: bad option: --warmup"
  ; before main.cjs ever runs, so `Exec '"...exe" --warmup'` silently did nothing.
  ; SetEnvironmentVariable is process-scoped for the child NSIS spawns, so it does
  ; not leak to the user's shell.
  ;
  ; Exec (not ExecWait) keeps the installer instant; the warmup runs detached and
  ; exits on its own (~60 s). It deliberately skips the single-instance lock so it
  ; can never block the user's own launch.
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_WARMUP", t "1")'
  Exec '"$INSTDIR\DeepSeekAgent.exe"'
  System::Call 'kernel32::SetEnvironmentVariable(t "DSH_WARMUP", t "")'

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\DeepSeekAgent.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\DeepSeekAgent.exe"

  WriteRegStr HKCU "Software\${APPNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayIcon" "$INSTDIR\DeepSeekAgent.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayVersion" "${APPVERSION}"

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  InitPluginsDir
  ; Primary: robocopy /MIR mirrors an empty directory into $INSTDIR, removing all
  ; of its contents. robocopy uses \\?\ extended-length paths internally, so deep
  ; node_modules trees (>MAX_PATH) are deleted too. On locked-down hosts where
  ; robocopy is unavailable, the RMDir retry below is the fallback.
  ;
  ; Run via nsExec (not ExecWait) so NO console window flashes at the user; a raw
  ; robocopy console scrolls alarming file/dir listing output during uninstall.
  ; /NFL /NDL /NJH /NJS /NP suppress every normal stdout line; /R:1 /W:1 cap the
  ; retry policy (robocopy defaults to /R:1000000 /W:30, which would otherwise
  ; hang the hidden process for hours on a file still locked by AV).
  CreateDirectory "$PLUGINSDIR\empty"
  nsExec::Exec 'robocopy /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 "$PLUGINSDIR\empty" "$INSTDIR"'
  Pop $0

  ; Hardening: NSIS RMDir /r aborts at the first file it cannot delete, typically
  ; one transiently locked by AV real-time scanning. Retry so every file is
  ; removed as the scanner releases its handle.
  StrCpy $0 0
  u_loop:
    RMDir /r "$INSTDIR"
    ; Stop as soon as nothing remains (robocopy already emptied it in the common
    ; case) instead of always sleeping through all 30 retries.
    IfFileExists "$INSTDIR\*.*" 0 u_done
    IntOp $0 $0 + 1
    IntCmp $0 30 u_done
    Sleep 1000
    Goto u_loop
  u_done:

  ; Schedule any still-held file (e.g. the running uninstall.exe) for deletion at
  ; next reboot so nothing is orphaned.
  RMDir /r /REBOOTOK "$INSTDIR"

  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKCU "Software\${APPNAME}"
SectionEnd
