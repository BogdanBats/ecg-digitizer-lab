"""Test-session setup."""

# Import the app package (and with it PyTorch, see app/__init__.py) while pytest is still loading conftests:
# imported later from inside a test module, torch's c10.dll can fail to initialise on Windows (WinError 1114) and
# the U-Net based digitization tests would silently run the classical fallback instead.
import app  # noqa: F401
