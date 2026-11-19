"""
Launcher for the ECG Photo Digitizer & Clinical Caliper Workstation.
Run with:
    python run.py
"""

import uvicorn

if __name__ == "__main__":
    print("=" * 72)
    print("  ECG Photo Digitizer & Clinical Caliper Workstation")
    print("  Open in browser: http://127.0.0.1:8055")
    print("=" * 72)
    uvicorn.run("app.server:app", host="127.0.0.1", port=8055, reload=False)
