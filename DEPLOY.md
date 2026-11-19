# Deploy ZionCore private backend

## Public pages (done)

- Entrance: https://tariromasawi.github.io/zioncore-command-interface/
- Command: https://tariromasawi.github.io/zioncore-command-interface/command.html

GitHub Pages is static only. Sign-in and live engines need a Node host.

## Private backend (same origin as command UI)

1. Create a free web service on **Render**, **Railway**, or **Fly.io**.
2. Connect repo `tariromasawi/zioncore-command-interface`.
3. Start command: `node server/index.js`
4. Environment: `PORT` is set by the host.
5. After deploy, open `https://YOUR-HOST/command.html` for live API on the same origin.

Demo sign-in (change before real use):
- commander / masawi-throne-77
- heir / masawi-throne-77

Mwari ndi Mwari.
