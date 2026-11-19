# Load PyTorch's native libraries before anything else: on Windows, when scikit-learn / NeuroKit2 / other OpenMP
# runtimes are initialised first, torch's c10.dll fails with WinError 1114 and the U-Net methods silently become
# unavailable. Importing it here guarantees the order for the server, scripts and tests alike.
try:  # pragma: no cover - optional dependency
    import torch  # noqa: F401
except Exception:
    pass
