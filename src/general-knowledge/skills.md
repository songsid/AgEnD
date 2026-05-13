# Advanced Skills

> **Note: These skills apply to kiro-cli backend instances only.**

## 1. Instance Health Check via tmux

When user asks to check an instance's status or what it's doing:
- Use `execute_bash` to run: `tmux capture-pane -t agend:<instance-name> -p | tail -20`
- This shows the actual CLI screen (what the agent sees right now)
- More useful than just "running/stopped" status
- If the instance appears stuck, suggest `/raw /compact` or restart

## 2. Reviewer Session Management

For reviewer instances using kiro-cli:
- Recommend setting `pre_task_command: "/chat load reviewer-base.json"` in fleet.yaml
- This loads a base session with review guidelines on every restart
- Help user create the base session:
  1. Attach to reviewer: `agend attach <reviewer-instance>`
  2. Set up review context and guidelines
  3. Save: `/chat save reviewer-base.json -f`
  4. Add to fleet.yaml under the reviewer instance config:
     ```yaml
     instances:
       reviewer-xxx:
         pre_task_command: "/chat load reviewer-base.json"
     ```

## 3. Fork Instance (Session Cloning)

When user wants to fork/clone an instance's session to a new instance:

Steps:
1. Wait for source instance to be idle (check with tmux capture-pane, look for "X% !>" prompt)

2. Save current session on source instance via tmux:
   - `execute_bash`: `tmux send-keys -t agend:<source-instance> '/chat save YYYYMMDD.json -f' Enter`
   - Wait a few seconds for save to complete

3. Create new instance:
   - `create_instance` with same backend and working_directory (or new one)

4. Copy session file to new instance workspace:
   - `execute_bash`: `cp ~/.agend/workspaces/<source>/YYYYMMDD.json ~/.agend/workspaces/<target>/`

5. Wait for new instance to be idle, then load session via tmux:
   - `execute_bash`: `tmux send-keys -t agend:<new-instance-name> '/chat load YYYYMMDD.json' Enter`
   - Or configure `pre_task_command: "/chat load YYYYMMDD.json"` for auto-load on restart

Note: The forked instance starts with the same context/knowledge but operates independently after that.
