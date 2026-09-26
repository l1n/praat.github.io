#!/bin/sh
# Prints the comma-separated list of exported symbols: every pw_* function defined in praat_web.cpp.
grep -oE '^PW_EXPORT [^(]*\bpw_[A-Za-z0-9_]+' "$(dirname "$0")/praat_web.cpp" | grep -oE 'pw_[A-Za-z0-9_]+$' | sed 's/^/_/' | paste -sd, -
