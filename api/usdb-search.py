# api/usdb-search.py
import json
import requests
from bs4 import BeautifulSoup
from urllib.parse import urljoin
import zipfile
from io import BytesIO
import os

def handler(event, context):
    # Solo POST
    if event['httpMethod'] != 'POST':
        return {"statusCode": 405, "body": "Method Not Allowed"}

    try:
        body = json.loads(event['body'])
        query = body.get('query', '').strip()
        if not query:
            return {"statusCode": 400, "body": json.dumps({"error": "Falta query"})}

        session = requests.Session()

        # Login a USDB (usa variables de entorno para seguridad)
        session.post("https://usdb.eu/login", data={
            "email": os.environ.get("USDB_EMAIL"),
            "password": os.environ.get("USDB_PASS"),
            "remember": "1"
        }, timeout=10)

        # Búsqueda
        search_resp = session.get("https://usdb.eu/search", params={"q": query}, timeout=10)
        soup = BeautifulSoup(search_resp.text, "html.parser")

        results = []
        rows = soup.select("table.songlist tr")[1:11]  # Max 10 resultados

        for row in rows:
            cols = row.find_all("td")
            if len(cols) < 5: continue

            artist = cols[0].get_text(strip=True)
            title = cols[1].get_text(strip=True)
            download_link = urljoin("https://usdb.eu", cols[-1].find("a")["href"])

            # Descargar ZIP y extraer el .txt
            zip_resp = session.get(download_link, timeout=15)
            if zip_resp.status_code != 200:
                continue

            with zipfile.ZipFile(BytesIO(zip_resp.content)) as z:
                txt_files = [f for f in z.namelist() if f.endswith(".txt")]
                if not txt_files:
                    continue

                txt_content = z.read(txt_files[0]).decode("utf-8", errors="ignore")

                results.append({
                    "artist": artist,
                    "title": title,
                    "txt": txt_content,
                    "source": "USDB"
                })

            if len(results) >= 3:  # Máximo 3 canciones para no abusar
                break

        return {
            "statusCode": 200,
            "headers": {"Content-Type": "application/json"},
            "body": json.dumps(results, ensure_ascii=False)
        }

    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }