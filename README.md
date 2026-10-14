# Whispr

Whispr is a realtime chat application with registration, sign-in, direct conversations, online presence, typing signals, file uploads, reporting, and a data-backed administration view.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. The first registered account is an administrator. All other accounts are members and can be found through the new-conversation search.

## Deploy

Set `PORT` to the port supplied by the host and set a long, persistent `JWT_SECRET`. The app stores its runtime data in `data/whispr.json` and uploaded files in `uploads/`; attach persistent storage for both directories in production. These are intentionally ignored by Git so no user content is shipped in the repository.

The included JSON store makes local development simple. Before a multi-instance or high-volume production deployment, replace the store with a managed database and object storage, and serve the app through HTTPS.
