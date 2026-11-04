---
section: Added
---
- Paired runtimes report their package version, code Build ID, supported protocols and capabilities. Computer information shows these reports and an explicit fallback for older runtimes; `agend-runtime --version` inspects the local installation without connecting.
- Runtime downloads from the connection flow include the reviewed AgEnD address and a double-click `connect-agend.bat` launcher. New profiles still pair interactively; matching saved profiles reconnect, and credentials never move to another server.
- Existing Agents can switch between the Fleet host, native Windows and paired Windows computers from their Runtime and CLI settings. The Agent identity, routing and AgEnD chat history stay together. The replacement starts paused with a fresh CLI conversation; existing files and provider sessions stay on the original computer.
