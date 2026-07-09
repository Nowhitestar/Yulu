"""
Agent 通知队列：脚本把事件写入队列文件，
agent（闪电）在心跳中读取并推送到 Telegram。

用法：
  from agent_notify import notify
  notify("transcribing", title="项目周会")
  notify("summarizing", title="项目周会")
  notify("transcript", title="项目周会", path="/path/to/transcript.txt")
  notify("summary_ready", title="项目周会", path="/path/to/summary.md")
"""

from queue_store import append_event


def notify(event_type: str, **kwargs):
    """添加一条通知到队列。"""
    append_event(event_type, **kwargs)
