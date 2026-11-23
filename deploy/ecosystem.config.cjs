// PM2 process for the app (used by deploy/deploy.sh and deploy/rollback.sh).
// Runs Next.js directly (not through npm) so cluster mode works. Two or more instances only on PostgreSQL:
// the JSON file store allows one process. Set VELZA_INSTANCES in the shell before deploying to change it.

const APP_DIR = process.env.APP_DIR || "/srv/velza";
const instances = Number(process.env.VELZA_INSTANCES || 1);

module.exports = {
  apps: [
    {
      name: "velza",
      cwd: `${APP_DIR}/current`,
      script: "node_modules/next/dist/bin/next",
      args: `start -p ${process.env.PORT || 3000}`,
      instances,
      exec_mode: instances > 1 ? "cluster" : "fork",
      env: { NODE_ENV: "production" },
      max_memory_restart: "1500M",
      kill_timeout: 10000,
      time: true,
    },
  ],
};
