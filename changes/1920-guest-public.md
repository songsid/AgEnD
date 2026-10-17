---
section: Security
---
- **Web: guests can sign in through the public link while an admin has it open (#1920).**
  - **How:** a guest's `/web` while the link is open sends the link along with the code. The code works through the link and on the dashboard reached directly. Only an admin opens or closes the link, and a guest through it sees only their own agents, as anywhere else.
  - **Admins stay aware:** a guest signing in through the link is posted in the General of the admin who opened it, before the sign-in works. If that can't be posted (the link was closed, its admin is no longer one, or the guest has nothing left to see), the sign-in is refused.
  - **When the link closes:** a guest code stops working through the link but still works on the dashboard reached directly. Guest sessions on the link end with it.
