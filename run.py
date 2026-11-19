"""
Launcher for the ECG Photo Digitizer & Clinical Caliper Workstation.
Run with:
    python run.py                     # http://127.0.0.1:8055
    python run.py --port 8060         # another port (or env ECG_PORT=8060)
    python run.py --host 0.0.0.0      # expose in the local network (or env ECG_HOST)
"""

import argparse
import os

import uvicorn

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ECG Photo Digitizer & Clinical Caliper Workstation")
    parser.add_argument("--host", default=os.environ.get("ECG_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("ECG_PORT", "8055")))
    args = parser.parse_args()

    print("=" * 72)
    print("  ECG Photo Digitizer & Clinical Caliper Workstation")
    print(f"  Open in browser: http://{args.host}:{args.port}")
    print("=" * 72)
    uvicorn.run("app.server:app", host=args.host, port=args.port, reload=False)
