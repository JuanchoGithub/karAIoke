# api/usdb-search.py
import json
import os
import traceback
from io import BytesIO
import zipfile
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin

# ← LOGGING MÁXIMO (esto aparece en los logs de Vercel)
def log(msg):
    print(f"[USDB] {msg}")

def handler(event, context):
    log("→ Función invocada")
    log(f"Event: {json.dumps(event)[:500]}...")  # solo primeros 500 chars

    if event.get("httpMethod") != "POST":
        log("Error: método no permitido")
        return {"statusCode": 405, "body": "Method Not Allowed"}

    try:
        body = json.loads(event.get("body") or "{}")
        query = body.get("query", "").strip()
        if not query:
            log("Error: query vacío")
            return {"statusCode": 400, "body": json.dumps({"error": "Falta query"})}

        log(f"Buscando: {query}")

        session = requests.Session()
        session.headers.update({"User-Agent": "Mozilla/5.0 (compatible; karAIoke-bot)"})

        # LOGIN (con timeout y logging)
        login_url = "https://usdb.eu/login"
        login_payload = {
            "email": os.environ.get("USDB_EMAIL"),
            "password": os.environ.get("USDB_PASS"),
            "remember": "1"
        }
        log("Intentando login...")
        login_resp = session.post(login_url, data=login_payload, timeout=15, allow_redirects=True)
        log(f"Login status: {login_resp.status_code} | URL final: {login_resp.url}")

        if "dashboard" not in login_resp.url and "logout" not in login_resp.text:
            log("Login falló (credenciales malas o captcha)")
            return {"statusCode": 401, "body": json.dumps({"error": "Login falló en USDB"})}

        log("Login exitoso")

        # BÚSQUEDA
        search_url = "https://usdb.eu/search"
        search_resp = session.get(search_url, params={"q": query}, timeout=15)
        log(f"Búsqueda status: {search_resp.status_code}")

        if search_resp.status_code != 200:
            log("Error en búsqueda")
            return {"statusCode": 502, "body": json.dumps({"error": "USDB no responde"})}

        soup = BeautifulSoup(search_resp.text, "html.parser")
        rows = soup.select("table.songlist tr")[1:11]  # primeros 10 resultados
        log(f"Encontrados {len(rows)} filas en tabla")

        results = []
        for i, row in enumerate(rows):
            log(f"Procesando fila {i+1}")
            cols = row.find_all("td")
            if len(cols) < 5:
                log("Fila sin columnas suficientes → skip")
                continue

            artist = cols[0].get_text(strip=True)
            title  = cols[1].get_text(strip=True)
            dl_link = cols[-1].find("a")
            if not dl_link:
                log("No hay link de descarga → skip")
                continue

            download_url = urljoin("https://usdb.eu", dl_link["href"])
            log(f"Descargando ZIP: {download_url}")

            zip_resp = session.get(download_url, timeout=20)
            if zip_resp.status_code != 200:
                log(f"ZIP error {zip_resp.status_code} → skip")
                continue

            try:
                with zipfile.ZipFile(BytesIO(zip_resp.content)) as z:
                    txt_files = [f for f in z.namelist() if f.lower().endswith(".txt")]
                    if not txt_files:
                        log("No hay .txt en el ZIP → skip")
                        continue

                    txt_content = z.read(txt_files[0]).decode("utf-8", errors="replace")
                    results.append({
                        "artist": artist,
                        "title": title,
                        "txt": txt_content,
                        "source": "USDB"
                    })
                    log(f"Éxito: {artist} - {title}")
            except zipfile.BadZipFile:
                log("ZIP corrupto → skip")
                continue

            if len(results) >= 3:  # máximo 3 para no abusar
                break

        log(f"Resultado final: {len(results)} canciones")
        return {
            "statusCode": 200,
            "headers":