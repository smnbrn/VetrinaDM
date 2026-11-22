#!/usr/bin/env python3
"""Build the VetrinaDM dataset from the Duel Masters Fandom wiki (MediaWiki API).

Outputs (all under data/):
  index.json       slim list used by the grid / search / filters (one short-key record per card)
  cards/<id>.json  full record of a card (all printings, variants with images, Twinpact side B...)
  sets.json        one record per set (code, name, format, size, sample image)

Pipeline
  1. list every page that embeds {{Cardtable}} (the card template);
  2. download their wikitext in batches of 50 and parse the template;
  3. read the wiki's per-set "Gallery" pages to get one image per printing (variants)
     and to learn whether a set is TCG or OCG;
  4. resolve image file names to CDN URLs with batched imageinfo queries.

Politeness: descriptive User-Agent, 50 titles per request, maxlag, a pause between
network calls and an on-disk cache so nothing is downloaded twice. Stdlib only.

Usage:
  python scripts/fetch_cards.py                  # everything
  python scripts/fetch_cards.py --limit-pages 300  # quick test run
  python scripts/fetch_cards.py --refresh        # ignore the cache
"""
import argparse
import hashlib
import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

API = "https://duelmasters.fandom.com/api.php"
WIKI = "https://duelmasters.fandom.com/wiki/"
USER_AGENT = "VetrinaDM/1.0 (non-commercial fan project; MediaWiki API client)"
ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(__file__).resolve().parent / ".cache"
DATA = ROOT / "data"

BATCH = 50          # titles per request (MediaWiki limit for normal users)
PAUSE = 1.0         # seconds between uncached requests
MAX_VARIANTS = 12   # images kept per card (some staples have 40+ reprints)
CIVS = ["Light", "Water", "Darkness", "Fire", "Nature", "Zero"]

_last_call = 0.0


# --------------------------------------------------------------------------
# API access with disk cache
# --------------------------------------------------------------------------
def api(params, refresh=False):
    """GET the MediaWiki API; responses are cached on disk by parameter hash."""
    global _last_call
    params = {**params, "format": "json", "formatversion": "2", "maxlag": "5"}
    key = hashlib.sha1(json.dumps(params, sort_keys=True).encode()).hexdigest()
    cache_file = CACHE_DIR / f"{key}.json"
    if cache_file.exists() and not refresh:
        return json.loads(cache_file.read_text(encoding="utf-8"))

    url = API + "?" + urllib.parse.urlencode(params)
    for attempt in range(5):
        wait = PAUSE - (time.time() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            if "error" in data and data["error"].get("code") == "maxlag":
                time.sleep(5 * (attempt + 1))
                continue
            break
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
            print(f"  request failed ({exc}); retrying", file=sys.stderr)
            time.sleep(5 * (attempt + 1))
    else:
        raise RuntimeError(f"API call kept failing: {params}")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def api_continue(params, refresh=False):
    """Yield every page of a continued query."""
    cont = {}
    while True:
        data = api({**params, **cont}, refresh)
        yield data
        if "continue" not in data:
            return
        cont = data["continue"]


def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


# --------------------------------------------------------------------------
# Wikitext parsing
# --------------------------------------------------------------------------
def extract_template(text, name="Cardtable"):
    """Return the raw ``{{Cardtable ...}}`` block (brace-matched) or None."""
    m = re.search(r"\{\{\s*" + name, text, re.I)
    if not m:
        return None
    depth, i = 0, m.start()
    while i < len(text):
        if text.startswith("{{", i):
            depth += 1
            i += 2
        elif text.startswith("}}", i):
            depth -= 1
            i += 2
            if depth == 0:
                return text[m.start():i]
        else:
            i += 1
    return None


def parse_params(block):
    """Split a template block into {key: raw value}, honouring nested {{ }} / [[ ]]."""
    body = block[2:-2]
    parts, cur, depth, i = [], [], 0, 0
    while i < len(body):
        two = body[i:i + 2]
        if two in ("{{", "[["):
            depth += 1
            cur.append(two)
            i += 2
        elif two in ("}}", "]]"):
            depth -= 1
            cur.append(two)
            i += 2
        elif body[i] == "|" and depth == 0:
            parts.append("".join(cur))
            cur = []
            i += 1
        else:
            cur.append(body[i])
            i += 1
    parts.append("".join(cur))
    params = {}
    for part in parts[1:]:
        if "=" in part:
            key, value = part.split("=", 1)
            params[key.strip().lower()] = value.strip()
    return params


_TEMPLATE = re.compile(r"\{\{([^{}|]+)(?:\|([^{}]*))?\}\}")


def _template_repl(m):
    name = m.group(1).strip()
    args = (m.group(2) or "").split("|")
    # {{Ruby|base|furigana}} and {{Icon|X}} -> first argument; others (e.g. the
    # keyword templates {{Double Breaker|jp}}) -> the template name itself.
    if name.lower() in ("ruby", "icon"):
        return args[0]
    return name


def clean(text):
    """Turn wikitext into plain text (keeps line breaks)."""
    if not text:
        return ""
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    prev = None
    while prev != text:               # innermost templates first
        prev = text
        text = _TEMPLATE.sub(_template_repl, text)
    text = re.sub(r"\[\[(?:File|Image):[^\]]*\]\]", "", text, flags=re.I)
    text = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]*)\]\]", r"\1", text)
    text = re.sub(r"'{2,}", "", text)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{2,}", "\n", text)
    return text.strip()


def split_list(value):
    return [p.strip() for p in re.split(r"\s*/\s*|\s*,\s*", clean(value)) if p.strip()]


def parse_civs(value):
    out = []
    for c in re.findall("|".join(CIVS), value or "", re.I):
        c = c.capitalize()
        if c not in out:
            out.append(c)
    return out


def to_int(value):
    m = re.fullmatch(r"\s*(\d+)\s*", value or "")
    return int(m.group(1)) if m else None


def power_num(value):
    m = re.match(r"\s*(\d+)", value or "")
    return int(m.group(1)) if m else None


# --------------------------------------------------------------------------
# Sets / printings
# --------------------------------------------------------------------------
def set_code_and_name(full):
    """'DM-01 Base Set (OCG)' -> ('DM-01-OCG', 'Base Set (OCG)')."""
    if full.strip().lower() == "promotional":
        return "PROMO", "Promozionali"
    m = re.match(r"^(\S+)\s*(.*)$", full.strip())
    code, name = (m.group(1), m.group(2)) if m else (full, full)
    if "(OCG)" in full:
        code += "-OCG"
    return code, name or code


def guess_format(full_name, card_cats):
    """Fallback when no gallery page tells us whether a set is TCG or OCG."""
    if "(OCG)" in full_name:
        return "OCG"
    m = re.match(r"DM-(\d+)", full_name)   # the Wizards TCG ran DM-01..DM-12 (assumption)
    if m and int(m.group(1)) <= 12 and "TCG" in card_cats:
        return "TCG"
    return "OCG"


def parse_printings(params, card_cats):
    out = []
    for key in sorted((k for k in params if re.fullmatch(r"set\d+", k)),
                      key=lambda k: int(k[3:])):
        n = key[3:]
        full = clean(params[key])
        if not full:
            continue
        code, name = set_code_and_name(full)
        out.append({
            "set_code": code,
            "set_nome": name,
            "set_completo": full,
            "numero": clean(params.get("setnum" + n, "")),
            "rarita": clean(params.get("r" + n, "")),
            "formato": guess_format(full, card_cats),
        })
    return out


# --------------------------------------------------------------------------
# Card assembly
# --------------------------------------------------------------------------
def slugify(title):
    s = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:90].strip("-")
    return s or hashlib.sha1(title.encode()).hexdigest()[:10]


def build_card(title, wikitext):
    block = extract_template(wikitext)
    if not block:
        return None
    p = parse_params(block)
    cats = set(re.findall(r"\[\[Category:(TCG|OCG)\]\]", wikitext))
    printings = parse_printings(p, cats)
    if not printings:
        return None

    main = printings[0]
    # Colourless cards (e.g. Zeniths) have no civilization on the wiki -> "Zero".
    civs = parse_civs(p.get("civilization")) or ["Zero"]
    is_twin = bool(p.get("name2") or p.get("cost2") or p.get("engtext2") or p.get("type2"))
    parts = [s.strip() for s in title.split(" / ")]

    card = {
        "id": slugify(title),
        "nome_en": clean(p.get("name")) or parts[0],
        "nome_jp": clean(p.get("jpname")),
        "nome_it": clean(p.get("itname")),
        "civilta": civs,
        "costo": to_int(p.get("cost")),
        "potere": clean(p.get("power")) or None,
        "potere_num": power_num(p.get("power")),
        "tipo": "Twinpact" if is_twin else (clean(p.get("type")) or "Altro"),
        "razze": split_list(p.get("race", "")),
        "testo": clean(p.get("engtext")),
        "testo_jp": clean(p.get("jptext")),
        "mana": to_int(p.get("mana")),
        "set_code": main["set_code"],
        "set_nome": main["set_nome"],
        "rarita": main["rarita"],
        "numero": main["numero"],
        "formato": main["formato"],
        "illustratori": [clean(v) for k, v in sorted(p.items())
                         if re.fullmatch(r"artist\d*", k) and clean(v)][:6],
        "url_immagine": None,
        "url_wiki": WIKI + urllib.parse.quote(title.replace(" ", "_"), safe="/:,()!'"),
        "_title": title,
        "_image_file": clean(p.get("image")),
        "_printings": printings,
        "_cats": sorted(cats),
    }
    if is_twin:
        twin_civs = parse_civs(p.get("twincivilization") or p.get("civilization2")) or civs
        card["lato_b"] = {
            "nome_en": clean(p.get("name2")) or (parts[1] if len(parts) > 1 else ""),
            "nome_jp": clean(p.get("jpname2")),
            "civilta": twin_civs,
            "tipo": clean(p.get("type2")) or "Spell",
            "costo": to_int(p.get("cost2")),
            "razze": split_list(p.get("race2", "")),
            "testo": clean(p.get("engtext2")),
            "testo_jp": clean(p.get("jptext2")),
        }
        card["tipo_lato_a"] = clean(p.get("type"))
        card["civilta"] = sorted(set(civs) | set(twin_civs), key=CIVS.index)
    return card


def norm_title(t):
    t = t.replace("_", " ").strip()
    return t[:1].upper() + t[1:]


# --------------------------------------------------------------------------
# Galleries -> variants (+ set format)
# --------------------------------------------------------------------------
_GALLERY_LINE = re.compile(
    r"^\s*([^|\n<]+?)\s*\|\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]\s*(?:<br\s*/?>\s*(.*?))?\s*$", re.I)


def gallery_titles(full):
    """Candidate wiki titles of the gallery page of a set."""
    if full.endswith("(OCG)"):
        return [full[:-5].strip() + " Gallery (OCG)"]
    return [full + " Gallery (TCG)", full + " Gallery (OCG)", full + " Gallery"]


def load_galleries(set_names, refresh):
    """-> ({set: {card title: [(file, number)]}}, {set: 'TCG'|'OCG'})."""
    cand = {}
    for full in set_names:
        for t in gallery_titles(full):
            cand[t] = full
    galleries, formats = {}, {}
    for batch in chunks(sorted(cand), BATCH):
        data = api({"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
                    "titles": "|".join(batch), "redirects": "1"}, refresh)["query"]
        for pg in data.get("pages", []):
            if pg.get("missing") or "revisions" not in pg:
                continue
            full = cand.get(pg["title"])
            if not full or full in galleries:
                continue
            rows = defaultdict(list)
            for line in pg["revisions"][0]["slots"]["main"]["content"].splitlines():
                m = _GALLERY_LINE.match(line)
                if m:
                    rows[norm_title(m.group(2))].append((m.group(1), clean(m.group(3) or "")))
            galleries[full] = rows
            if pg["title"].endswith("(TCG)"):
                formats[full] = "TCG"
            elif pg["title"].endswith("(OCG)"):
                formats[full] = "OCG"
    return galleries, formats


def attach_variants(cards, refresh):
    sets = sorted({pr["set_completo"] for c in cards for pr in c["_printings"]})
    print(f"Looking up galleries for {len(sets)} sets", flush=True)
    galleries, formats = load_galleries(sets, refresh)
    print(f"  {len(galleries)} galleries found", flush=True)

    for c in cards:
        for pr in c["_printings"]:                       # authoritative TCG/OCG when known
            pr["formato"] = formats.get(pr["set_completo"], pr["formato"])
        c["formato"] = c["_printings"][0]["formato"]

        title = norm_title(c["_title"])
        seen, variants = set(), []
        for pr in c["_printings"]:
            for file, num in galleries.get(pr["set_completo"], {}).get(title, []):
                key = norm_title(file)
                if key in seen:
                    continue
                seen.add(key)
                same = [q for q in c["_printings"] if q["set_completo"] == pr["set_completo"] and q["numero"] == num]
                variants.append({
                    "set_code": pr["set_code"], "set_nome": pr["set_nome"],
                    "numero": num or pr["numero"],
                    "rarita": (same[0] if same else pr)["rarita"],
                    "formato": pr["formato"],
                    "_file": file,
                })
        main = norm_title(c["_image_file"]) if c["_image_file"] else None
        variants.sort(key=lambda v: norm_title(v["_file"]) != main)   # card's own image first
        if main and not any(norm_title(v["_file"]) == main for v in variants):
            mp = c["_printings"][0]
            variants.insert(0, {"set_code": mp["set_code"], "set_nome": mp["set_nome"], "numero": mp["numero"],
                                "rarita": mp["rarita"], "formato": mp["formato"], "_file": c["_image_file"]})
        c["varianti"] = variants[:MAX_VARIANTS]


def resolve_images(cards, refresh):
    wanted = set()
    for c in cards:
        if c["_image_file"]:
            wanted.add("File:" + norm_title(c["_image_file"]))
        wanted.update("File:" + norm_title(v["_file"]) for v in c["varianti"])
    files = sorted(wanted)
    print(f"Resolving {len(files)} image files", flush=True)
    urls = {}
    for n, batch in enumerate(chunks(files, BATCH)):
        data = api({"action": "query", "prop": "imageinfo", "iiprop": "url",
                    "titles": "|".join(batch), "redirects": "1"}, refresh)["query"]
        redirects = {r["from"]: r["to"] for r in data.get("redirects", [])}
        by_title = {pg["title"]: pg["imageinfo"][0]["url"]
                    for pg in data.get("pages", []) if pg.get("imageinfo")}
        for f in batch:
            norm = f.replace("_", " ")
            urls[f] = by_title.get(redirects.get(norm, norm))
        if n % 100 == 99:
            print(f"  {(n + 1) * BATCH}/{len(files)}", flush=True)
    for c in cards:
        if c["_image_file"]:
            c["url_immagine"] = urls.get("File:" + norm_title(c["_image_file"]))
        for v in c["varianti"]:
            v["url_immagine"] = urls.get("File:" + norm_title(v.pop("_file")))
        c["varianti"] = [v for v in c["varianti"] if v["url_immagine"]]
        if not c["url_immagine"] and c["varianti"]:
            c["url_immagine"] = c["varianti"][0]["url_immagine"]


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------
def dump(path, obj):
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def write_outputs(cards):
    # unique ids
    used = Counter()
    for c in cards:
        used[c["id"]] += 1
        if used[c["id"]] > 1:
            c["id"] += f"-{used[c['id']]}"

    cards_dir = DATA / "cards"
    if cards_dir.exists():
        shutil.rmtree(cards_dir)
    cards_dir.mkdir(parents=True)

    index, sets = [], {}
    for c in cards:
        prints = c["_printings"]
        full = {k: v for k, v in c.items() if not k.startswith("_")}
        full["stampe"] = [{k: v for k, v in pr.items() if k != "set_completo"} for pr in prints]
        dump(cards_dir / f"{c['id']}.json", full)

        b = c.get("lato_b") or {}
        text = " ".join(t for t in (c["testo"], b.get("testo"), b.get("nome_en")) if t)
        index.append({
            "id": c["id"], "n": c["nome_en"], "j": c["nome_jp"], "i": c["nome_it"],
            "c": c["civilta"], "k": c["costo"], "p": c["potere_num"], "t": c["tipo"],
            "r": c["razze"], "x": text[:280], "im": c["url_immagine"], "v": len(c["varianti"]),
            "P": [[pr["set_code"], pr["numero"], pr["rarita"], pr["formato"]] for pr in prints][:30],
        })
        for pr in prints:
            s = sets.setdefault(pr["set_code"], {"code": pr["set_code"], "nome": pr["set_nome"],
                                                 "formato": pr["formato"], "n": 0, "img": None})
            s["n"] += 1
            s["img"] = s["img"] or c["url_immagine"]

    dump(DATA / "index.json", index)
    dump(DATA / "sets.json", sorted(sets.values(), key=lambda s: s["code"]))
    old = DATA / "cards.json"
    if old.exists():
        old.unlink()
    print(f"Wrote {len(index)} cards and {len(sets)} sets to {DATA}")


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--limit-pages", type=int, default=0, help="only process the first N card pages (testing)")
    ap.add_argument("--refresh", action="store_true", help="ignore the local cache")
    args = ap.parse_args()

    titles = []
    for data in api_continue({"action": "query", "list": "embeddedin", "eititle": "Template:Cardtable",
                              "eilimit": "500", "einamespace": "0"}, args.refresh):
        titles += [p["title"] for p in data["query"]["embeddedin"]]
    titles = sorted(set(titles))
    if args.limit_pages:
        titles = titles[:args.limit_pages]
    print(f"{len(titles)} card pages", flush=True)

    cards = []
    for n, batch in enumerate(chunks(titles, BATCH)):
        data = api({"action": "query", "prop": "revisions", "rvprop": "content", "rvslots": "main",
                    "titles": "|".join(batch)}, args.refresh)["query"]
        for pg in data.get("pages", []):
            if pg.get("missing") or "revisions" not in pg:
                continue
            card = build_card(pg["title"], pg["revisions"][0]["slots"]["main"]["content"])
            if card:
                cards.append(card)
        if n % 20 == 19:
            print(f"  parsed {(n + 1) * BATCH}/{len(titles)} pages, {len(cards)} cards", flush=True)
    print(f"{len(cards)} cards parsed", flush=True)

    attach_variants(cards, args.refresh)
    resolve_images(cards, args.refresh)
    cards.sort(key=lambda c: (c["nome_en"].lower(), c["id"]))
    DATA.mkdir(exist_ok=True)
    write_outputs(cards)


if __name__ == "__main__":
    main()
