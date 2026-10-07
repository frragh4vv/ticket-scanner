"""🎟️ TicketMaker CLI - Multi-Tier QR & Database Generator

Generates cryptographically unique QR codes categorized by tier:
- VIP passes (VIP-XXXXXX)
- General Admission passes (GEN-XXXXXX)
- Guestlist passes (GST-XXXXXX)
"""

import qrcode
import secrets
import csv
import os
import shutil

# Configuration
QR_FOLDER = "tickets_output"
CSV_FILE = "tickets_database.csv"

# Batch counts
TIER_COUNTS = {
    "VIP": 50,
    "General": 400,
    "Guestlist": 50
}

PREFIX_MAP = {
    "VIP": "VIP",
    "General": "GEN",
    "Guestlist": "GST"
}

def generate_code(length=6):
    charset = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(charset) for _ in range(length))

def main():
    # 1. Clean slate: Wipe old local assets
    if os.path.exists(QR_FOLDER):
        shutil.rmtree(QR_FOLDER)
    os.makedirs(QR_FOLDER)

    for tier in TIER_COUNTS.keys():
        os.makedirs(os.path.join(QR_FOLDER, tier.lower()), exist_ok=True)

    if os.path.exists(CSV_FILE):
        os.remove(CSV_FILE)

    ticket_rows = []
    total_generated = 0

    print("🚀 Generating multi-tier QR tickets...")

    # 2. Generate per tier
    for tier, count in TIER_COUNTS.items():
        prefix = PREFIX_MAP.get(tier, "GEN")
        print(f"  • Generating {count} {tier} tickets ({prefix}-*)...")

        for i in range(1, count + 1):
            ticket_id = f"{prefix}-{generate_code(6)}"
            
            # Render High-Resolution QR code
            qr = qrcode.QRCode(
                version=1,
                error_correction=qrcode.constants.ERROR_CORRECT_H,
                box_size=10,
                border=4,
            )
            qr.add_data(ticket_id)
            qr.make(fit=True)
            img = qr.make_image(fill_color="black", back_color="white")
            
            # Save into tier folder
            file_path = os.path.join(QR_FOLDER, tier.lower(), f"{ticket_id}.png")
            img.save(file_path)

            ticket_rows.append([ticket_id, tier, "Valid", "", "", "", ""])
            total_generated += 1

    # 3. Save to CSV manifest
    with open(CSV_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Ticket_ID", "Tier", "Status", "Attendee_Name", "Email", "Scanned_By", "Scan_Time"])
        writer.writerows(ticket_rows)

    print(f"\n✅ Success! Generated {total_generated} tickets in '{QR_FOLDER}/' and saved to '{CSV_FILE}'.")

if __name__ == "__main__":
    main()