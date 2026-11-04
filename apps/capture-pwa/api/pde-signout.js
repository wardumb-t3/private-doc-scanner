// Vercel function: expire the T3 session cookie that the /t3 relay put on
// this origin (HttpOnly — page code cannot clear it). Holds no data.
export default function handler(_req, res) {
  res.setHeader("Set-Cookie", "t3_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/");
  res.setHeader("Cache-Control", "no-store");
  res.status(204).end();
}
