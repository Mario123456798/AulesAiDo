# Aules Sync Agent (Python + HTML + CSS)

Implementación completa en **Python 3.11+**, **HTML5** y **CSS3** (sin dependencias Node.js ni frameworks externos obligatorios).

## Ejecución rápida

1. Copia el archivo de entorno y configura tu clave de Groq:
   ```bash
   cp .env.example .env
   ```
   Edita `.env` y añade `GROQ_API_KEY=...` (y opcionalmente `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` si quieres sincronizar con Google Drive mediante OAuth).

2. Inicia el servidor web:
   ```bash
   python3 app.py
   ```

3. Abre `http://localhost:3000` en tu navegador.
   - Si no definiste `AULES_APP_PASSCODE`, la pantalla inicial te permitirá crear tu contraseña de acceso local en el primer arranque.
   - Conecta Aules en **Conexiones** y ejecuta el agente desde **Proceso en Vivo**.
