"""Convert the leads spreadsheet into data/leads.json (then load it with scripts/seed_supabase.mjs).

Usage: python3 scripts/convert_leads.py "/path/to/leads.xlsx"
"""
import json, sys, pathlib
import openpyxl

src = sys.argv[1] if len(sys.argv) > 1 else "leads.xlsx"
wb = openpyxl.load_workbook(src, read_only=True)
rows = list(wb["All Leads"].iter_rows(values_only=True))
header, body = rows[0], rows[1:]

leads = []
for r in body:
    d = dict(zip(header, r))
    if not d.get("email"):
        continue
    leads.append({
        "id": str(d["email"]).strip().lower(),
        "wave": d["priority_wave"],
        "nicheGroup": d["niche_group"] or "",
        "score": d["priority_score"],
        "hook": d["hook"] or "",
        "pitchAngle": d["pitch_angle"] or "",
        "emailType": d["email_type"] or "",
        "businessName": d["business_name"] or "",
        "industry": d["industry"] or "",
        "niche": d["niche"] or "",
        "specificCategory": d["specific_category"] or "",
        "whatTheyDo": d["what_they_do"] or "",
        "city": d["city"] or "",
        "address": d["address"] or "",
        "rating": d["rating"],
        "reviews": d["reviews"],
        "websiteStatus": d["website_status"] or "",
        "website": d["website"] or "",
        "whyOutdated": d["why_outdated"] or "",
        "email": str(d["email"]).strip(),
        "emailFoundAt": d["email_found_at"] or "",
        "googleMaps": d["google_maps"] or "",
    })

out = pathlib.Path(__file__).resolve().parent.parent / "data" / "leads.json"
out.write_text(json.dumps(leads, separators=(",", ":")))
print(f"wrote {len(leads)} leads to {out}")
