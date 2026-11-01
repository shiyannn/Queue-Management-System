# CHO Walk-In FIFO Clinic Queue Management System

A local, offline-capable First-In, First-Out (FIFO) queue management system built specifically for walk-in clinics and City Health Offices (CHO).

---

## 🌟 Key Features

1. **Strict FIFO Queueing**:
   - Tickets are called in exact chronological arrival order (`created_at`).
   - Integrated Priority Lane support (complies with Senior Citizen, PWD, Pregnant, and Emergency requirements).
   - Sequence numbers reset daily automatically.

2. **Zero-Internet / Offline Local Network (LAN) Ready**:
   - Runs locally on a single clinic PC or mini-PC server.
   - Any tablet, phone, laptop, or Smart TV on the clinic Wi-Fi/LAN can connect via the server's IP address.

3. **Multi-Station Flow & Patient Routing**:
   - Triage / Vital Signs $\to$ Doctor Consultation (Doctor 1, Doctor 2, Dental, Prenatal) $\to$ Pharmacy / Laboratory.
   - Doctors and nurses can transfer patients directly to the next station with clinical referral notes.

4. **Waiting Area Public TV Screen (`/display`)**:
   - Large-screen layout with huge "NOW SERVING" spotlight and room counters.
   - Built-in two-tone audio chime (synthesized Web Audio, no external audio files required).
   - Automated text-to-speech voice announcements (*"Now serving ticket number R 0 0 5 at Counter 2, Doctor 1"*).
   - Flashing visual alerts and "Next in Line" ticker.

5. **Patient Self-Service / Reception Kiosk (`/kiosk`)**:
   - Large touchable buttons for fast walk-in intake.
   - Printable 58mm/80mm thermal ticket preview with auto-close countdown.

6. **Doctor & Staff Terminal (`/staff`)**:
   - 1-click **CALL NEXT (FIFO)**.
   - **Recall**: Re-triggers TV visual flash and chime.
   - **No-Show / Hold**: Puts patient on temporary hold if they stepped out, preventing line bottlenecks.
   - **Transfer Station**: Easily route to Doctor, Lab, or Pharmacy.
   - **Complete**: Finalize service and discharge.

---

## 🚀 How to Run

### 1. Start the Server
```bash
npm start
```
By default, the server runs on port `3000`.

### 2. Access the System

| Module | URL | Description |
| :--- | :--- | :--- |
| **Control Hub** | `http://localhost:3000/` | Main overview and live clinic stats |
| **Patient Kiosk** | `http://localhost:3000/kiosk` | For patient intake or touch screen kiosk |
| **Waiting Area TV** | `http://localhost:3000/display` | For waiting room TV / lobby monitor |
| **Staff Terminal** | `http://localhost:3000/staff` | For Doctors, Nurses, and Pharmacists |

> **LAN / Clinic Wi-Fi Tip**:
> Find your computer's local IP (e.g., `192.168.1.50` by running `ipconfig` in terminal).
> Open `http://192.168.1.50:3000/display` on the Smart TV or tablet connected to the clinic Wi-Fi!

---

## 🛠️ Handy Commands

- **Run Automated Test Suite**:
  ```bash
  npm test
  ```
  Simulates ticket issuing, priority FIFO calling, station transfer, hold, and completion.

- **Reset Today's Queue to Clean Slate**:
  ```bash
  npm run reset
  ```

---

## 📁 Project Structure

```
CHO-QUEUEING/
├── database.js        # SQLite setup (stations, categories, tickets, logs)
├── queueService.js    # Core FIFO queue logic, station transfers, stats
├── server.js          # Express server + Socket.io real-time WebSocket events
├── test_queue.js      # Automated test verifying FIFO rules
├── reset_db.js        # Script to clear queue records
└── public/
    ├── index.html     # Control Hub & live stations monitor
    ├── kiosk.html     # Patient intake / ticket issuing screen
    ├── display.html   # Public Waiting Area TV with Chime & Voice
    └── staff.html     # Doctor & Staff calling panel
```
doctor name for each terminal
dra. mennie doc 1
dr. perry doc two
dr. dhiet doc 3
dra. yvonne dental
pharmacist: 
