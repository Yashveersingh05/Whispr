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

For Render, create a new **Blueprint** from the GitHub repository. The included `render.yaml` supplies the build/start commands and generates `JWT_SECRET`. On other Node hosts, set `PORT` to the host-provided port and set a long, persistent `JWT_SECRET` yourself.

The app stores its runtime data in `data/whispr.json` and uploaded files in `uploads/`; attach persistent storage for both directories in production. These are intentionally ignored by Git so no user content is shipped in the repository.

The included JSON store makes local development simple. Before a multi-instance or high-volume production deployment, replace the store with a managed database and object storage, and serve the app through HTTPS.
