#!/usr/bin/env python3
"""Aggiorna videos.json con i video della playlist fissa e gli ultimi video dei canali.

Legge config.json (e, se c'è, subscriptions.csv esportato da Google Takeout).
Gira su GitHub Actions ogni 8 ore. Non serve nessuna chiave API.
"""
import csv, json, sys, time, urllib.request, xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

import yt_dlp

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
MAX = int(CONFIG.get("video_per_canale", 6))
SKIP_SHORTER = int(CONFIG.get("escludi_video_sotto_minuti", 2)) * 60

YDL = yt_dlp.YoutubeDL({"extract_flat": "in_playlist", "quiet": True, "no_warnings": True,
                        "skip_download": True, "ignoreerrors": True})


def clean(e):
    return {"id": e["id"], "title": e.get("title") or "", "dur": int(e.get("duration") or 0)}


def channel_url(ref):
    ref = ref.strip().rstrip("/")
    if ref.startswith("http"):
        for tab in ("/videos", "/featured", "/streams", "/shorts"):
            if ref.endswith(tab):
                ref = ref[: -len(tab)]
        return ref + "/videos"
    if ref.startswith("@"):
        return f"https://www.youtube.com/{ref}/videos"
    return f"https://www.youtube.com/channel/{ref}/videos"


def rss_videos(query):
    """Feed RSS: [(id, titolo, data)] dal più recente."""
    url = f"https://www.youtube.com/feeds/videos.xml?{query}"
    ns = {"a": "http://www.w3.org/2005/Atom", "yt": "http://www.youtube.com/xml/schemas/2015"}
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            root = ET.fromstring(r.read())
        return [(e.find("yt:videoId", ns).text, e.find("a:title", ns).text or "", e.find("a:published", ns).text)
                for e in root.findall("a:entry", ns)]
    except Exception as ex:
        print(f"  RSS non disponibile ({query}): {ex}")
        return []


def load_playlist(url):
    info = YDL.extract_info(url, download=False)
    if not info:
        print(f"! Playlist non trovata: {url}")
        return None
    vids = [clean(e) for e in info.get("entries") or [] if e and e.get("id")
            and e.get("title") not in ("[Private video]", "[Deleted video]")]
    print(f"Playlist '{info.get('title')}': {len(vids)} video")
    return {"title": info.get("title") or "Playlist", "id": info.get("id"), "videos": vids}


def load_channel(ref):
    YDL.params["playlistend"] = MAX * 4
    info = YDL.extract_info(channel_url(ref), download=False)
    if not info:
        print(f"! Canale non trovato: {ref}")
        return None
    cid = info.get("channel_id") or info.get("id")
    durs = {e["id"]: int(e.get("duration") or 0) for e in info.get("entries") or [] if e and e.get("id")}
    # Feed dei soli video lunghi (UULF): dà le date giuste ed esclude Shorts e dirette
    feed = rss_videos("playlist_id=UULF" + cid[2:]) if cid and cid.startswith("UC") else []
    vids = []
    if feed:
        for vid, title, date in feed:
            d = durs.get(vid, 0)
            if d and d < SKIP_SHORTER:
                continue
            vids.append({"id": vid, "title": title, "dur": d, "date": date})
            if len(vids) >= MAX:
                break
    else:  # riserva: elenco della scheda Video, senza date
        for e in info.get("entries") or []:
            if e and e.get("id"):
                v = clean(e)
                if v["dur"] and v["dur"] < SKIP_SHORTER:
                    continue
                v["date"] = None
                vids.append(v)
                if len(vids) >= MAX:
                    break
    name = info.get("channel") or info.get("uploader") or info.get("title") or ref
    print(f"Canale '{name}': {len(vids)} video")
    return {"name": name.replace(" - Videos", ""), "id": cid, "videos": vids}


def load_fixed_videos(urls):
    """Singoli video da tenere sempre fissi, raccolti in un gruppo unico (titoli via oEmbed, senza blocchi)."""
    import re, urllib.parse
    vids = []
    for u in urls:
        m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([\w-]{11})", u)
        if not m:
            print(f"! Link video non valido: {u}")
            continue
        vid = m.group(1)
        title = ""
        try:
            q = urllib.parse.quote("https://www.youtube.com/watch?v=" + vid, safe="")
            with urllib.request.urlopen(f"https://www.youtube.com/oembed?format=json&url={q}", timeout=20) as r:
                title = json.loads(r.read()).get("title", "")
        except Exception as ex:
            print(f"  titolo non disponibile per {vid}: {ex}")
        vids.append({"id": vid, "title": title or "Video " + vid, "dur": 0})
    print(f"Video fissi: {len(vids)}")
    return {"title": CONFIG.get("nome_video_fissi", "Esercizi fissi"), "id": None, "videos": vids} if vids else None


def channel_refs():
    refs = list(CONFIG.get("canali", []))
    takeout = ROOT / "subscriptions.csv"
    if takeout.exists():
        with takeout.open(encoding="utf-8-sig") as f:
            for row in csv.reader(f):
                if row and row[0].startswith("UC"):
                    refs.append(row[0])
    seen, out = set(), []
    for r in refs:
        k = r.strip().lower()
        if k and k not in seen:
            seen.add(k)
            out.append(r.strip())
    return out


def main():
    out_path = ROOT / "videos.json"
    old = json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}

    playlists = []
    if CONFIG.get("video_fissi"):
        fixed = load_fixed_videos(CONFIG["video_fissi"])
        if fixed:
            playlists.append(fixed)
    playlists += [p for p in (load_playlist(u) for u in CONFIG.get("playlist_fisse", [])) if p]
    channels = []
    for ref in channel_refs():
        try:
            c = load_channel(ref)
            if c:
                channels.append(c)
        except Exception as ex:
            print(f"! Errore con {ref}: {ex}")
        time.sleep(1)

    # Se YouTube ha bloccato tutto, tiene i dati vecchi invece di svuotare l'app
    if not playlists and old.get("playlists"):
        playlists = old["playlists"]
    if not channels and old.get("channels"):
        channels = old["channels"]

    data = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "playlists": playlists, "channels": channels}
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Salvato videos.json: {len(playlists)} playlist, {len(channels)} canali")


if __name__ == "__main__":
    sys.exit(main())
