declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    LIGA_ADMIN_EMAIL?: string;
  }
}
