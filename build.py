#!/usr/bin/env python3
"""Build Tough Tech Weekly from the submissions sheet.

Reads a CSV (published Google Sheet tab, or a local file), groups submissions
into weekly issues, and writes index.html, submit.html, reminders.html,
issues/*.html and feed.xml. No dependencies beyond the standard library.
"""
import csv, html, io, json, os, re, sys, urllib.parse, urllib.request
from datetime import datetime, date, timedelta, timezone

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = ROOT  # output dir; overridden by --out for preview builds
UA = "Mozilla/5.0 (compatible; ToughTechWeekly/1.0; +https://toughtechcapstone.github.io/)"
MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]


def cfg():
    with open(os.path.join(ROOT, "config.json")) as f:
        return json.load(f)


def tpl(name):
    with open(os.path.join(ROOT, "templates", name)) as f:
        return f.read()


def blocklist():
    p = os.path.join(ROOT, "data", "blocklist.txt")
    if not os.path.exists(p):
        return []
    out = []
    for line in open(p):
        line = line.strip().lower()
        if line and not line.startswith("#"):
            out.append(line)
    return out


# ---------- input ----------

def load_rows(conf, local_csv=None):
    if local_csv:
        text = open(local_csv, encoding="utf-8").read()
    elif conf.get("sheet_csv_url"):
        req = urllib.request.Request(conf["sheet_csv_url"], headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8", "replace")
    else:
        p = os.path.join(ROOT, "data", "submissions.csv")
        if not os.path.exists(p):
            return []
        text = open(p, encoding="utf-8").read()
    rows = []
    for raw in csv.DictReader(io.StringIO(text)):
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in raw.items()}
        if any(row.values()):
            rows.append(row)
    return rows


def parse_ts(s):
    s = (s or "").strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S",
                "%Y-%m-%d %H:%M", "%m/%d/%Y %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s[:19], fmt)
        except ValueError:
            continue
    return None


def norm_url(u):
    try:
        p = urllib.parse.urlsplit(u)
    except ValueError:
        return u.lower()
    q = [(k, v) for k, v in urllib.parse.parse_qsl(p.query)
         if not k.lower().startswith("utm_") and k.lower() not in
         ("fbclid", "gclid", "mc_cid", "mc_eid", "ref", "s", "igshid")]
    host = p.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    path = p.path.rstrip("/") or "/"
    return urllib.parse.urlunsplit((p.scheme.lower(), host, path,
                                    urllib.parse.urlencode(q), ""))


def fetch_title(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=10) as r:
            chunk = r.read(200000).decode(r.headers.get_content_charset() or "utf-8", "replace")
        m = re.search(r"<title[^>]*>(.*?)</title>", chunk, re.S | re.I)
        if m:
            t = html.unescape(re.sub(r"\s+", " ", m.group(1))).strip()
            return t[:180] or None
    except Exception as e:
        print(f"  ! title fetch failed for {url}: {e.__class__.__name__}", file=sys.stderr)
    return None


def clean(rows, terms, do_fetch=True):
    items, seen, held = [], set(), 0
    for row in rows:
        url = row.get("url") or row.get("link") or ""
        if not re.match(r"^https?://", url, re.I):
            continue
        status = (row.get("status") or "").lower()
        if status in ("held", "removed", "hidden", "spam"):
            held += 1
            continue
        note = row.get("note") or row.get("blurb") or row.get("context") or ""
        title = row.get("title") or ""
        hay = f"{url} {note} {title}".lower()
        if any(t in hay for t in terms):
            print(f"  ! held on blocklist: {url}", file=sys.stderr)
            held += 1
            continue
        key = norm_url(url)
        if key in seen:
            continue
        seen.add(key)
        ts = parse_ts(row.get("timestamp") or row.get("date") or "")
        if ts is None:
            continue
        name = (row.get("name") or row.get("first name") or "").strip()
        name = re.split(r"[\s,]+", name)[0][:40] if name else ""
        tag = (row.get("tag") or "").strip().lower()
        local = "socal" in tag or "local" in tag or "socal" in note.lower()
        if not title and do_fetch:
            title = fetch_title(url) or ""
        host = urllib.parse.urlsplit(url).netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        items.append({"url": url, "title": title or host, "note": note,
                      "name": name, "host": host, "local": local, "ts": ts})
    items.sort(key=lambda i: i["ts"])
    return items, held


# ---------- issues ----------

def friday_of(d):
    return d + timedelta(days=(4 - d.weekday()))


def group(items):
    weeks = {}
    for it in items:
        weeks.setdefault(it["ts"].date().isocalendar()[:2], []).append(it)
    issues = []
    for n, key in enumerate(sorted(weeks), start=1):
        year, wk = key
        monday = date.fromisocalendar(year, wk, 1)
        issues.append({"n": n, "year": year, "week": wk, "monday": monday,
                       "published": friday_of(monday),
                       "slug": f"issues/{year}-w{wk:02d}.html",
                       "items": weeks[key]})
    return issues


def pretty(d):
    return f"{MONTHS[d.month - 1]} {d.day}, {d.year}"


def render_items(items):
    out = []
    for it in items:
        tag = '<span class="tag">SoCal</span>' if it["local"] else ""
        why = ""
        if it["note"]:
            cite = f'<cite>&mdash; {html.escape(it["name"])}</cite>' if it["name"] else ""
            why = f'<p class="why">{html.escape(it["note"])}{cite}</p>'
        elif it["name"]:
            why = f'<p class="note">Submitted by {html.escape(it["name"])}</p>'
        out.append(
            '    <div class="item">\n'
            f'      <h3><a href="{html.escape(it["url"], quote=True)}" rel="noopener nofollow">{html.escape(it["title"])}</a></h3>\n'
            f'      <p class="src">{html.escape(it["host"])}{tag}</p>\n'
            f'      {why}\n'
            '    </div>'
        )
    return "\n".join(out)


def conditionals(text, flags):
    """Resolve <!--IF:NAME--> ... <!--ENDIF:NAME--> blocks against a flag dict."""
    for name, on in flags.items():
        pat = re.compile(r"<!--IF:%s-->(.*?)<!--ENDIF:%s-->" % (name, name), re.S)
        text = pat.sub((lambda m: m.group(1)) if on else "", text)
    return text


def page(conf, title, desc, canon, content, prefix=""):
    form = conf.get("form_url", "").strip()
    email = conf.get("email", "").strip()
    live = bool(email) and "REPLACE-ME" not in email.upper()
    flags = {"FORM": bool(form), "EMAIL": live, "NOEMAIL": not live}
    # Until the submissions inbox exists, contact links fall back to a real address.
    email_out = email if live else conf.get("fallback_email", "jane.wu@anderson.ucla.edu")
    body = conditionals(tpl("base.html"), flags)
    content = conditionals(content, flags)
    body = body.replace("{{CONTENT}}", content)
    for k, v in (("{{TITLE}}", title), ("{{DESC}}", desc), ("{{CANON}}", canon),
                 ("{{PREFIX}}", prefix), ("{{SITE}}", conf["site"]),
                 ("{{EMAIL}}", email_out), ("{{FORM_URL}}", form)):
        body = body.replace(k, v)
    return body


def write(path, text):
    full = os.path.join(OUT, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"  wrote {path}")


def build(conf, issues, outdir=None):
    global OUT
    OUT = outdir or ROOT
    latest = issues[-1] if issues else None

    # --- index ---
    c = [f'    <p class="masthead-note">A weekly roundup of what the MGMT 274A/B cohort is reading in deep tech &mdash; and what is happening in the LA hard tech corridor. Written by the class, one forwarded email at a time. <a href="submit.html">Send us something.</a></p>']
    if latest:
        c.append('    <div class="issue-head">')
        c.append(f'      <h2>Issue {latest["n"]}</h2>')
        c.append(f'      <p class="issue-date">{pretty(latest["published"])} &middot; {len(latest["items"])} link{"s" if len(latest["items"]) != 1 else ""}</p>')
        c.append('    </div>')
        c.append(render_items(latest["items"]))
    else:
        c.append('    <div class="empty"><strong>Issue 1 lands this Friday.</strong>'
                 'Nothing has been submitted yet &mdash; be the first. Forward any interesting '
                 f'deep tech link to <a href="submit.html">the inbox</a> and it runs in the next issue.</div>')
    if len(issues) > 1:
        c.append('    <h2 id="archive">Archive</h2>')
        c.append('    <ul class="archive">')
        for iss in reversed(issues[:-1]):
            c.append(f'      <li><span class="when">{pretty(iss["published"])}</span>'
                     f'<span><a href="{iss["slug"]}">Issue {iss["n"]}</a></span>'
                     f'<span class="count">{len(iss["items"])} links</span></li>')
        c.append('    </ul>')
    write("index.html", page(conf, "Tough Tech Weekly — UCLA Anderson",
          "A weekly roundup of deep tech and LA hard tech corridor news, assembled by the MGMT 274A/B cohort at UCLA Anderson.",
          "", "\n".join(c)))

    # --- issue pages ---
    for iss in issues:
        c = ['    <div class="issue-head">', f'      <h2>Issue {iss["n"]}</h2>',
             f'      <p class="issue-date">{pretty(iss["published"])} &middot; {len(iss["items"])} link{"s" if len(iss["items"]) != 1 else ""}</p>',
             '    </div>', render_items(iss["items"]),
             '    <p class="note" style="margin-top:22px"><a href="../index.html">&larr; All issues</a></p>']
        write(iss["slug"], page(conf, f"Issue {iss['n']} — Tough Tech Weekly",
              f"Tough Tech Weekly issue {iss['n']}, {pretty(iss['published'])}: {len(iss['items'])} links from the MGMT 274A/B cohort.",
              iss["slug"], "\n".join(c), prefix="../"))

    # --- static pages ---
    write("submit.html", page(conf, "Submit a link — Tough Tech Weekly",
          "How to send a link to Tough Tech Weekly: forward an email from your UCLA address.",
          "submit.html", tpl("submit.html")))
    write("reminders.html", page(conf, "Key course reminders — MGMT 274A/B",
          "Meeting dates, deadlines, and course goals for MGMT 274A/B Tough Tech Commercialization at UCLA Anderson.",
          "reminders.html", tpl("reminders.html")))

    # --- rss ---
    now = datetime.now(timezone.utc).strftime("%a, %d %b %Y %H:%M:%S +0000")
    x = ['<?xml version="1.0" encoding="UTF-8"?>',
         '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">', '<channel>',
         '<title>Tough Tech Weekly</title>', f'<link>{conf["site"]}</link>',
         '<description>Deep tech and LA hard tech corridor links, assembled weekly by the MGMT 274A/B cohort at UCLA Anderson.</description>',
         '<language>en-us</language>', f'<lastBuildDate>{now}</lastBuildDate>',
         f'<atom:link href="{conf["site"]}feed.xml" rel="self" type="application/rss+xml"/>']
    for iss in reversed(issues[-25:]):
        pub = datetime.combine(iss["published"], datetime.min.time()).strftime("%a, %d %b %Y 15:00:00 +0000")
        body = "".join(
            f'<p><a href="{html.escape(i["url"], quote=True)}">{html.escape(i["title"])}</a> ({html.escape(i["host"])})'
            + (f'<br>{html.escape(i["note"])}' + (f' &mdash; {html.escape(i["name"])}' if i["name"] else "") if i["note"] else "")
            + '</p>' for i in iss["items"])
        x += ['<item>', f'<title>Issue {iss["n"]} — {pretty(iss["published"])}</title>',
              f'<link>{conf["site"]}{iss["slug"]}</link>',
              f'<guid isPermaLink="true">{conf["site"]}{iss["slug"]}</guid>',
              f'<pubDate>{pub}</pubDate>',
              f'<description><![CDATA[{body}]]></description>', '</item>']
    x += ['</channel>', '</rss>']
    write("feed.xml", "\n".join(x) + "\n")


def main():
    args = sys.argv[1:]
    local = outdir = None
    do_fetch = "--no-fetch" not in args
    for i, a in enumerate(args):
        if a == "--csv":
            local = args[i + 1]
        if a == "--out":
            outdir = args[i + 1]
    conf = cfg()
    rows = load_rows(conf, local)
    items, held = clean(rows, blocklist(), do_fetch)
    issues = group(items)
    print(f"{len(rows)} rows -> {len(items)} items in {len(issues)} issues ({held} held)")
    build(conf, issues, outdir)


if __name__ == "__main__":
    main()
