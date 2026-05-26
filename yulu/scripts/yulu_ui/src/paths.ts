import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".config", "yulu");
const MOVIES_DIR = join(HOME, "Movies", "Yulu");

export const paths = {
  configDir:        CONFIG_DIR,
  configFile:       join(CONFIG_DIR, "config.json"),
  promptsDb:        join(CONFIG_DIR, "prompts.sqlite"),
  vocabDb:          join(CONFIG_DIR, "vocab.sqlite"),
  searchDb:         join(CONFIG_DIR, "search.sqlite"),
  audioDaemonSock:  join(CONFIG_DIR, "audio_daemon.sock"),
  sttDaemonSock:    join(CONFIG_DIR, "stt_daemon.sock"),
  statusAgentSock:  join(CONFIG_DIR, "status_agent.sock"),
  uiLog:            join(CONFIG_DIR, "ui.log"),
  uiPid:            join(CONFIG_DIR, "yulu_ui.pid"),
  moviesDir:        MOVIES_DIR,
  voicemailsDir:    join(MOVIES_DIR, "voicemails"),
} as const;
