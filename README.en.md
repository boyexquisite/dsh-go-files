# dsh-go-files

A native **Workspace** panel for the dsh-go phone app: browse the host's workspace from the sidebar, preview text / images / videos, upload files from the phone, move and delete them.

- **Where**: conversation details → Plugins tab (`session.tab`); also under All features and the chat page's Plugins sheet.
- **Browse**: folders first; images as two-column thumbnail cards (tap a card for details, tap the picture for full screen), videos as cover + silent clip, other files open a text preview.
- **Upload**: system picker → workspace `artifacts/uploads/<date>/` (parent dirs are created on demand), collisions get a numeric suffix. 8 MiB per file, up to 4 files / 16 MiB per selection.
- **Move / delete**: from a file's detail page; delete needs confirmation, only empty folders can be deleted, symlinks and paths outside the workspace are refused.
- **Safety**: every path is confined to the workspace root.

```sh
dsh plugin --profile web add dsh-go-files
```

Workspace root defaults to the first entry of the DSH workspace registry (or the engine cwd); override with `DSH_WORKSPACE_ROOT`. Image/video previews are cached in the plugin's `assets/preview/` (64 files / 7 days) and need `ffmpeg`/`ffprobe` on the host.

MIT License.
