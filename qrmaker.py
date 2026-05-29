import qrcode
import uuid
import csv
import os
import shutil

# Configuration
QR_FOLDER = "tickets_for_appsheet"
CSV_FILE = "appsheet_database.csv"
COUNT = 1500

# 1. WIPE OLD DATA for a fresh start
if os.path.exists(QR_FOLDER):
    shutil.rmtree(QR_FOLDER) # Deletes the whole folder
os.makedirs(QR_FOLDER)

if os.path.exists(CSV_FILE):
    os.remove(CSV_FILE) # Deletes the old CSV

# 2. Generate 1000 fresh IDs and QR Images
ticket_data = []

print(f"Generating {COUNT} fresh QR codes...")
for i in range(1, COUNT + 1):
    # Generating a unique 8-character ID
    unique_id = str(uuid.uuid4())[:8] 
    
    # Create and Save QR
    img = qrcode.make(unique_id)
    img.save(f"{QR_FOLDER}/ticket_{i}.png")
    
    # Prepare row for CSV
    ticket_data.append([unique_id, "Valid", "", ""])

# 3. Save to a brand new CSV
with open(CSV_FILE, "w", newline="") as f:
    writer = csv.writer(f)
    writer.writerow(["Ticket_ID", "Status", "Scanned_By", "Scan_Time"])
    writer.writerows(ticket_data)

print(f"Success! {COUNT} fresh tickets are ready in '{QR_FOLDER}'.")