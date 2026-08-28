# toughtechcapstone.github.io

**Tough Tech Weekly** — a student-assembled newsletter of deep tech and LA hard tech
corridor links, for MGMT 274A/B at UCLA Anderson (Prof. Jane Wu).
Live at <https://toughtechcapstone.github.io>.

## How it works

```
student forwards an email  ──▶  Gmail  ──▶  Apps Script  ──┐
                                                           ├─▶  Google Sheet ──▶  GitHub Action ──▶  site
student fills the form     ──────────────────────────────  ┘      (queue tab)      (build.py)
```

No pre-moderation. The spam filter is the UCLA-sender restriction plus a term
blocklist; anything unwanted is removed after the fact by deleting or flagging a
row in the sheet, which drops it on the next build.

## Files

| Path | What it is |
|---|---|
| `build.py` | Site generator. Stdlib only, no dependencies. |
| `config.json` | Site URL, submission email, form URL, sheet CSV URL. |
| `templates/` | `base.html` shell plus the `submit` and `reminders` page bodies. |
| `assets/style.css` | All styling. |
| `data/blocklist.txt` | Terms that hold a submission out of an issue. |
| `apps-script/Code.gs` | Gmail intake, pasted into the Apps Script editor. |
| `.github/workflows/build.yml` | Builds Tuesdays and Fridays, and on demand. |
| `templates/svg/` | The line drawings, inlined at build time via `{{SVG:name}}`. |
| `index.html`, `issues/`, `submit.html`, `reminders.html` | **Generated — do not hand-edit.** |

## Local build

```sh
python3 build.py                      # uses config.json's sheet_csv_url
python3 build.py --csv data/sample-submissions.csv --no-fetch --out /tmp/preview
```

`--no-fetch` skips fetching page titles (faster, offline). `--out` writes a preview
elsewhere instead of overwriting the site.

To publish an issue immediately: Actions ▸ *Build newsletter* ▸ **Run workflow**.

See [SETUP.md](SETUP.md) for first-time wiring of the inbox, sheet, and form.
