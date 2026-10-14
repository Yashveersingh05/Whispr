# Whispr

Whispr is a realtime chat application with registration, sign-in, direct conversations, online presence, typing signals, file uploads, reporting, and a data-backed administration view.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. The first registered account is an administrator. All other accounts are members and can be found through the new-conversation search.

## Deploy

Whispr is a Node + Socket.IO application. It cannot be deployed as a Netlify static site because Netlify does not run this long-lived server or its WebSocket process. Deploy the repository to a Node host such as Render, Railway, Fly.io, or a VPS instead.

For Render, create a new **Blueprint** from the GitHub repository. The included `render.yaml` supplies the build/start commands, generates `JWT_SECRET`, and asks for `DATABASE_URL` and TURN settings. Create a managed PostgreSQL database and set its connection URL as `DATABASE_URL` before considering a deployment production ready. The app will store its application state in a PostgreSQL JSONB record when that setting is present. Without it, the local JSON store remains enabled for development and the server warns that deployed data can be lost.

For calls across restrictive mobile and corporate networks, configure a TURN server such as coturn with its shared-secret REST authentication. Set `TURN_URL` to its `turn:`/`turns:` address and `TURN_SHARED_SECRET` to the server's secret. Whispr creates short-lived TURN credentials for the signed-in user; the long-lived secret stays on the server. Without TURN, some network pairs will not connect even though voice/video permissions and signaling work. On other Node hosts, set `PORT`, `JWT_SECRET`, and `DATABASE_URL` yourself.

The app stores its runtime data in `data/whispr.json` and uploaded files in `uploads/`; attach persistent storage for both directories in production. These are intentionally ignored by Git so no user content is shipped in the repository.

Uploaded files currently use the `uploads/` directory. Configure a persistent disk for it, or add an object-storage provider before scaling beyond a single persistent server. Serve the application through HTTPS so browsers permit camera and microphone access.
