# 🎟️ Ticket Scanner & QR Code Generator

A robust Python utility designed to generate, manage, and structure ticket databases and QR codes, specifically optimized for seamless integration with no-code custom frontend solutions like **AppSheet**.

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
