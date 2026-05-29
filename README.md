# 🎟️ Secure Ticket Scanner & Serverless QR Generator (v2)

An ultra-scalable, secure, full-stack ticket management web service. This project evolved from a local Python generation script into a modern serverless backend API hosted on **Cloudflare Workers** with an integrated, high-performance web interface.

---

## ⚡ v1 (Original Script) vs v2 (Serverless Web App)

Here is a comparison of how this project evolved to achieve professional industry standards:

| Feature | 🐍 v1 (Original Local State) | ⛅ v2 (Modern Serverless Web App) |
| :--- | :--- | :--- |
| **Database Security** | ❌ **Insecure**: Firebase URL and Secret key were hardcoded in static HTML, exposing full database write access to any visitor. | ✅ **Secure**: Keys and secrets are hidden inside Cloudflare's serverless environment, protected by a `Bearer Raghav@ticket` auth token. |
| **Ticket Generation** | 🐍 **Manual Python Script**: Developer had to run `qrmaker.py` locally on their machine, consuming disk storage for 1,500 PNG images, and upload them manually. | 🌐 **Browser-based**: Generated with a single click inside the web panel. The browser renders and compresses the QRs into a `.zip` on-the-fly. |
| **Excel DB Metadata** | ❌ **Absent**: Local CSV database had to be manually synced with AppSheet. | ✅ **Automated**: Compiles an Excel-ready CSV mapping file (`ticket_list.csv` showing `ticket_X` -> `code`) directly inside the downloaded `.zip`! |
| **Mailing Capabilities** | ❌ **None**: No simple way to email tickets to buyers from the application. | ✅ **Integrated**: Send beautiful QR code emails directly from the web panel (manually or in bulk) using the **Brevo (Sendinblue) API** from your Gmail. |
| **Operational Overhead** | 🐍 **High**: Required Python installation, virtual environment setup, local execution, and manual cloud storage synchronization. | ⛅ **Zero**: Light static HTML pages hosted globally alongside the fast serverless Worker backend. Zero server costs when idle ($0). |

---

## ⚙️ How It Works & Architecture

This repository contains the developer utility scripts to configure, generate, and maintain your ticket system. The architecture relies on three primary parts:

1. **Generation Layer (`qrmaker.py`)**: A Python utility that wipes old data, generates fresh, highly unique 8-character ticket IDs (UUIDs), renders them into high-quality QR code PNG images, and records them in a clean database.
2. **Database Layer (`appsheet_database.csv`)**: Acts as the single source of truth for ticket validation. It contains fields for tracking scans:
   * `Ticket_ID`: The unique identifier encoded in the QR code.
   * `Status`: Current state of the ticket (e.g., `Valid`, `Scanned`).
   * `Scanned_By`: The user/device that scanned the ticket.
   * `Scan_Time`: Timestamp of when the verification took place.
3. **Frontend Layer (AppSheet)**: Since the frontend UI (for camera scanning, user logging, and status tracking) is fully hosted and managed directly inside **AppSheet**, it connects directly to your cloud-synchronized version of `appsheet_database.csv` and the `tickets_for_appsheet` folder.

---

## 📂 Project Structure

```bash
├── .gitignore               # Ensures heavy image files and virtual environments aren't pushed to GitHub
├── .python-version          # Python version configuration
├── pyproject.toml           # Project dependencies and packaging settings
├── uv.lock                  # Pinned dependency lockfile
├── README.md                # Project documentation
├── qrmaker.py               # Core script for generating unique tickets and QR codes
├── main.py                  # Boilerplate entry point
└── appsheet_database.csv    # The local ticket database (Single Source of Truth)
```

> [!NOTE]
> The **`tickets_for_appsheet/`** folder containing the generated `.png` QR code images is excluded from this GitHub repository via `.gitignore` to keep the codebase lightweight, clean, and professional.

---

## 🚀 Getting Started

### Prerequisites

* Python **3.14** or newer
* [uv](https://github.com/astral-sh/uv) (recommended) or standard `pip` for dependency management

### 1. Installation

If using `uv` (fast package manager), you can install all dependencies instantly:
```bash
uv sync
```

Alternatively, using standard pip:
```bash
pip install qrcode uuid
```

### 2. Generating Tickets

Run the QR code maker script to generate fresh tickets:
```bash
uv run qrmaker.py
```
This will:
1. Clear any previous generated assets in `tickets_for_appsheet/` and reset the database.
2. Generate **1,500** unique ticket codes and save them as PNGs.
3. Generate a brand new `appsheet_database.csv` sheet loaded with the fresh IDs.

---

## 📱 AppSheet Integration Guide

To deploy and use these assets in your AppSheet application:

1. **Upload Data & Images**: Upload the generated `appsheet_database.csv` file and the `tickets_for_appsheet` folder to your cloud storage account (such as **Google Drive** or **OneDrive**).
2. **Create/Update App**:
   * Open the **AppSheet Console** and connect `appsheet_database.csv` as your main data table.
   * Configure the `Status`, `Scanned_By`, and `Scan_Time` columns to allow updates.
3. **Configure Scanning**: Enable the **Barcode Scanner** option in the AppSheet table configuration for the `Ticket_ID` input column so scanner devices can trigger scans using their built-in cameras.
