/* praat_web.cpp
 *
 * A small C API around Praat's analysis code, compiled to WebAssembly for the
 * in-browser voice trainer in web/. Every exported function starts with pw_.
 *
 * Conventions:
 *   - The caller hands over mono samples (float, -1..1) with pw_setSound or pw_live.
 *   - Analysis functions fill one shared result buffer of doubles and return a
 *     pointer to it; pw_resultLength() tells how many doubles are valid.
 *     The buffer stays valid until the next analysis call.
 *   - Undefined values (unvoiced frames, missing formants) are NaN.
 *   - On failure a function returns nullptr (or NaN) and pw_lastError() holds the message.
 *
 * This code is distributed under the GNU General Public License, version 3 or later,
 * like the rest of Praat.
 */

#include "melder.h"
#include "Sound.h"
#include "Pitch.h"
#include "Sound_to_Pitch.h"
#include "Formant.h"
#include "Sound_to_Formant.h"
#include "Intensity.h"
#include "Sound_to_Intensity.h"
#include "Harmonicity.h"
#include "Sound_to_Harmonicity.h"
#include "PointProcess.h"
#include "Pitch_to_PointProcess.h"
#include "VoiceAnalysis.h"
#include "Spectrogram.h"
#include "Sound_and_Spectrogram.h"
#include "PowerCepstrogram.h"
#include "Sound_to_PowerCepstrogram.h"
#include "../dwsys/NUMmachar.h"
#include "../external/gsl/gsl_errno.h"

#include <vector>
#include <string>
#include <cmath>

#define PW_EXPORT extern "C" __attribute__((used))

static std::vector <double> theResult;
static std::string theError;
static autoSound theSound;

static double *result () {
	return theResult.data ();
}

static void rememberError () {
	theError = Melder_peek32to8 (Melder_getError ());
	Melder_clearError ();
}

static autoSound makeSound (const float *samples, integer numberOfSamples, double samplingFrequency) {
	const double dx = 1.0 / samplingFrequency;
	autoSound sound = Sound_create (1, 0.0, numberOfSamples * dx, numberOfSamples, dx, 0.5 * dx);
	for (integer i = 1; i <= numberOfSamples; i ++)
		sound -> z [1] [i] = samples [i - 1];
	return sound;
}

static inline double orNaN (double value) {
	return isdefined (value) ? value : NAN;
}

/*
	Initialization: the parts of Melder_init() that make sense without audio files or a GUI.
*/
PW_EXPORT int pw_init () {
	NUMmachar ();
	gsl_set_error_handler_off ();
	NUMrandom_initializeSafelyAndUnpredictably ();
	Melder_alloc_init ();
	Melder_batch = true;
	return 1;
}

PW_EXPORT const char *pw_lastError () {
	return theError.c_str ();
}

PW_EXPORT int pw_resultLength () {
	return (int) theResult.size ();
}

/*
	Live analysis of a short buffer (typically 0.15 to 0.25 s) that ends "now".
	Result (8 doubles):
		[0] f0 in Hz at the analysis time (NaN if unvoiced)
		[1] pitch strength (0..1) at that time
		[2..4] F1, F2, F3 in Hz (NaN if not found or unvoiced)
		[5] intensity of the last 50 ms in dB re full scale
		[6] analysis time relative to the end of the buffer (negative, seconds)
		[7] F4 in Hz
*/
PW_EXPORT double *pw_live (const float *samples, int numberOfSamples, double samplingFrequency,
	double pitchFloor, double pitchCeiling, double formantCeiling, double silenceDb)
{
	theResult.assign (8, NAN);
	try {
		autoSound sound = makeSound (samples, numberOfSamples, samplingFrequency);
		const double duration = sound -> xmax;

		/*
			Level of the most recent 50 ms, in dB relative to a full-scale sine wave.
		*/
		const integer levelSamples = std::min <integer> (numberOfSamples, Melder_iround (0.05 * samplingFrequency));
		double sumOfSquares = 0.0;
		for (integer i = numberOfSamples - levelSamples + 1; i <= numberOfSamples; i ++)
			sumOfSquares += sqr (sound -> z [1] [i]);
		const double meanSquare = sumOfSquares / std::max <integer> (levelSamples, 1);
		const double levelDb = 10.0 * log10 (2.0 * meanSquare + 1e-12);
		theResult [5] = levelDb;

		/*
			The analysis time lies half a pitch window before the end of the buffer,
			so that the window is filled with sound.
		*/
		const double windowDuration = 3.0 / pitchFloor;
		const double analysisTime = duration - 0.5 * windowDuration - 0.005;
		theResult [6] = analysisTime - duration;
		if (levelDb < silenceDb)
			return result ();

		autoPitch pitch = Sound_to_Pitch_rawAc (sound.get(), 0.01, pitchFloor, pitchCeiling,
				15, false, 0.03, 0.45, 0.01, 0.35, 0.14);
		const double f0 = Pitch_getValueAtTime (pitch.get(), analysisTime, kPitch_unit::HERTZ, true);
		if (! isdefined (f0))
			return result ();
		theResult [0] = f0;
		theResult [1] = orNaN (Pitch_getStrengthAtTime (pitch.get(), analysisTime, kPitch_unit::HERTZ, true));

		autoFormant formant = Sound_to_Formant_burg (sound.get(), 0.01, 5.0, formantCeiling, 0.025, 50.0);
		const integer iframe = Sampled_xToNearestIndex (formant.get(), analysisTime);
		if (iframe >= 1 && iframe <= formant -> nx) {
			const Formant_Frame frame = & formant -> frames [iframe];
			for (integer iformant = 1; iformant <= std::min <integer> (frame -> numberOfFormants, 3); iformant ++)
				theResult [1 + iformant] = frame -> formant [iformant]. frequency;
			if (frame -> numberOfFormants >= 4)
				theResult [7] = frame -> formant [4]. frequency;
		}
		return result ();
	} catch (MelderError) {
		rememberError ();
		return nullptr;
	}
}

/*
	Hand over a whole recording for the detailed analyses below.
	Recordings are resampled to at most 22050 Hz: that keeps everything up to 11 kHz,
	far above what voice measures need, and makes the cross-correlation analyses
	(harmonicity, voice report) several times faster than at 44.1 or 48 kHz.
	Returns its duration in seconds, or NaN on failure.
*/
PW_EXPORT double pw_setSound (const float *samples, int numberOfSamples, double samplingFrequency) {
	try {
		theSound = makeSound (samples, numberOfSamples, samplingFrequency);
		constexpr double analysisSamplingFrequency = 22050.0;
		if (samplingFrequency > analysisSamplingFrequency * 1.01)
			theSound = Sound_resample (theSound.get(), analysisSamplingFrequency, 50);
		return theSound -> xmax;
	} catch (MelderError) {
		rememberError ();
		theSound. reset ();
		return NAN;
	}
}

/*
	Pitch contour with Praat's filtered-autocorrelation method (the recommended method for intonation).
	Result: [t1, dt, n, f0_1 ... f0_n, strength_1 ... strength_n]
*/
PW_EXPORT double *pw_pitch (double timeStep, double pitchFloor, double pitchCeiling) {
	try {
		Melder_require (theSound, U"No sound.");
		autoPitch pitch = Sound_to_Pitch_filteredAc (theSound.get(), timeStep, pitchFloor, pitchCeiling,
				15, false, 0.03, 0.09, 0.50, 0.055, 0.35, 0.14);
		const integer n = pitch -> nx;
		theResult.assign (3 + 2 * n, NAN);
		theResult [0] = pitch -> x1;
		theResult [1] = pitch -> dx;
		theResult [2] = n;
		for (integer i = 1; i <= n; i ++) {
			if (Pitch_isVoiced_i (pitch.get(), i)) {
				theResult [2 + i] = pitch -> frames [i]. candidates [1]. frequency;
				theResult [2 + n + i] = pitch -> frames [i]. candidates [1]. strength;
			}
		}
		return result ();
	} catch (MelderError) {
		rememberError ();
		return nullptr;
	}
}

/*
	Formant tracks with Praat's Burg method.
	Result: [t1, dt, n, then per frame F1 F2 F3 F4 B1 B2 B3 B4]
*/
PW_EXPORT double *pw_formants (double timeStep, double maximumNumberOfFormants, double formantCeiling, double windowLength) {
	try {
		Melder_require (theSound, U"No sound.");
		autoFormant formant = Sound_to_Formant_burg (theSound.get(), timeStep, maximumNumberOfFormants,
				formantCeiling, windowLength, 50.0);
		const integer n = formant -> nx;
		theResult.assign (3 + 8 * n, NAN);
		theResult [0] = formant -> x1;
		theResult [1] = formant -> dx;
		theResult [2] = n;
		for (integer i = 1; i <= n; i ++) {
			const Formant_Frame frame = & formant -> frames [i];
			double *out = & theResult [3 + 8 * (i - 1)];
			for (integer iformant = 1; iformant <= std::min <integer> (frame -> numberOfFormants, 4); iformant ++) {
				out [iformant - 1] = frame -> formant [iformant]. frequency;
				out [3 + iformant] = frame -> formant [iformant]. bandwidth;
			}
		}
		return result ();
	} catch (MelderError) {
		rememberError ();
		return nullptr;
	}
}

/*
	Intensity contour in dB (relative to full scale, not calibrated).
	Result: [t1, dt, n, dB_1 ... dB_n]
*/
PW_EXPORT double *pw_intensity (double pitchFloor, double timeStep) {
	try {
		Melder_require (theSound, U"No sound.");
		autoIntensity intensity = Sound_to_Intensity (theSound.get(), pitchFloor, timeStep, true);
		const integer n = intensity -> nx;
		theResult.assign (3 + n, NAN);
		theResult [0] = intensity -> x1;
		theResult [1] = intensity -> dx;
		theResult [2] = n;
		/*
			Praat expresses intensity relative to 2e-5 Pa, i.e. it assumes the samples are in pascal.
			Browser audio is in "full scale" units instead, so we convert to dB re full-scale sine.
		*/
		const double offset = 10.0 * log10 (4e-10 * 2.0);
		for (integer i = 1; i <= n; i ++)
			theResult [2 + i] = intensity -> z [1] [i] + offset;
		return result ();
	} catch (MelderError) {
		rememberError ();
		return nullptr;
	}
}

/*
	Harmonics-to-noise ratio contour (autocorrelation method, much faster than cross-correlation
	in WebAssembly), in dB; NaN where silent.
	Result: [t1, dt, n, hnr_1 ... hnr_n]
*/
PW_EXPORT double *pw_harmonicity (double timeStep, double pitchFloor) {
	try {
		Melder_require (theSound, U"No sound.");
		autoHarmonicity harmonicity = Sound_to_Harmonicity_ac (theSound.get(), timeStep, pitchFloor, 0.1, 4.5);
		const integer n = harmonicity -> nx;
		theResult.assign (3 + n, NAN);
		theResult [0] = harmonicity -> x1;
		theResult [1] = harmonicity -> dx;
		theResult [2] = n;
		for (integer i = 1; i <= n; i ++) {
			const double value = harmonicity -> z [1] [i];
			if (value > -199.0)
				theResult [2 + i] = value;
		}
		return result ();
	} catch (MelderError) {
		rememberError ();
		return nullptr;
	}
}

/*
	Spectrogram (Gaussian window), in dB relative to the loudest cell, clipped at -dynamicRange.
	Result: [t1, dt, nt, f1, df, nf, then nt * nf values, frequency running fastest]
*/
PW_EXPORT double *pw_spectrogram (double windowLength, double maximumFrequency, double timeStep,
	double frequencyStep, double dynamicRange)
{
	try {
		Melder_require (theSound, U"No sound.");
		autoSpectrogram spectrogram = Sound_to_Spectrogram_e (theSound.get(), windowLength, maximumFrequency,
				timeStep, frequencyStep, kSound_to_Spectrogram_windowShape::GAUSSIAN, 8.0, 8.0);
		const integer nt = spectrogram -> nx, nf = spectrogram -> ny;
		theResult.assign (6 + nt * nf, NAN);
		theResult [0] = spectrogram -> x1;
		theResult [1] = spectrogram -> dx;
		theResult [2] = nt;
		theResult [3] = spectrogram -> y1;
		theResult [4] = spectrogram -> dy;
		theResult [5] = nf;
		double maximum = 1e-30;
		for (integer it = 1; it <= nt; it ++)
			for (integer jf = 1; jf <= nf; jf ++)
				maximum = std::max (maximum, spectrogram -> z [jf] [it]);
		const double maximumDb = 10.0 * log10 (maximum);
		for (integer it = 1; it <= nt; it ++) {
			double *out = & theResult [6 + (it - 1) * nf];
			for (integer jf = 1; jf <= nf; jf ++) {
				const double db = 10.0 * log10 (spectrogram -> z [jf] [it] + 1e-30) - maximumDb;
				out [jf - 1] = std::max (db, - dynamicRange);
			}
		}
		return result ();
	} catch (MelderError) {
		rememberError ();
		return nullptr;
	}
}

/*
	Voice report over [tmin, tmax] (tmax <= tmin means the whole sound), with the jitter and shimmer
	settings of Praat's Voice report. To keep this responsive in WebAssembly, the glottal pulses are
	placed with the filtered-autocorrelation pitch (instead of raw cross-correlation), harmonicity uses
	the autocorrelation method, and CPPS uses a 10 ms cepstrogram step with a least-squares trend line.
	Result (12 doubles):
		[0] jitter (local), fraction
		[1] jitter (rap), fraction
		[2] jitter (ppq5), fraction
		[3] shimmer (local), fraction
		[4] shimmer (local, dB)
		[5] shimmer (apq3), fraction
		[6] mean harmonics-to-noise ratio, dB
		[7] smoothed cepstral peak prominence (CPPS), dB
		[8] number of glottal pulses
		[9] number of periods
		[10] mean period, s
		[11] fraction of locally unvoiced frames
*/
PW_EXPORT double *pw_voiceReport (double tmin, double tmax, double pitchFloor, double pitchCeiling) {
	theResult.assign (12, NAN);
	try {
		Melder_require (theSound, U"No sound.");
		if (tmax <= tmin) {
			tmin = theSound -> xmin;
			tmax = theSound -> xmax;
		}
		autoPitch pitch = Sound_to_Pitch_filteredAc (theSound.get(), 0.01, pitchFloor, pitchCeiling,
				15, false, 0.03, 0.09, 0.50, 0.055, 0.35, 0.14);
		autoPointProcess pulses = Sound_Pitch_to_PointProcess_cc (theSound.get(), pitch.get());
		const double shortestPeriod = 0.0001, longestPeriod = 0.02, maximumPeriodFactor = 1.3, maximumAmplitudeFactor = 1.6;
		theResult [0] = orNaN (PointProcess_getJitter_local (pulses.get(), tmin, tmax, shortestPeriod, longestPeriod, maximumPeriodFactor));
		theResult [1] = orNaN (PointProcess_getJitter_rap (pulses.get(), tmin, tmax, shortestPeriod, longestPeriod, maximumPeriodFactor));
		theResult [2] = orNaN (PointProcess_getJitter_ppq5 (pulses.get(), tmin, tmax, shortestPeriod, longestPeriod, maximumPeriodFactor));
		theResult [3] = orNaN (PointProcess_Sound_getShimmer_local (pulses.get(), theSound.get(), tmin, tmax,
				shortestPeriod, longestPeriod, maximumPeriodFactor, maximumAmplitudeFactor));
		theResult [4] = orNaN (PointProcess_Sound_getShimmer_local_dB (pulses.get(), theSound.get(), tmin, tmax,
				shortestPeriod, longestPeriod, maximumPeriodFactor, maximumAmplitudeFactor));
		theResult [5] = orNaN (PointProcess_Sound_getShimmer_apq3 (pulses.get(), theSound.get(), tmin, tmax,
				shortestPeriod, longestPeriod, maximumPeriodFactor, maximumAmplitudeFactor));

		autoHarmonicity harmonicity = Sound_to_Harmonicity_ac (theSound.get(), 0.01, pitchFloor, 0.1, 4.5);
		theResult [6] = orNaN (Harmonicity_getMean (harmonicity.get(), tmin, tmax));

		const MelderIntegerRange window = PointProcess_getWindowPoints (pulses.get(), tmin, tmax);
		theResult [8] = window. last - window. first + 1;
		theResult [9] = PointProcess_getNumberOfPeriods (pulses.get(), tmin, tmax, shortestPeriod, longestPeriod, maximumPeriodFactor);
		theResult [10] = orNaN (PointProcess_getMeanPeriod (pulses.get(), tmin, tmax, shortestPeriod, longestPeriod, maximumPeriodFactor));

		integer numberOfFrames = 0, numberOfUnvoicedFrames = 0;
		for (integer i = 1; i <= pitch -> nx; i ++) {
			const double t = Sampled_indexToX (pitch.get(), i);
			if (t < tmin || t > tmax)
				continue;
			numberOfFrames ++;
			if (! Pitch_isVoiced_i (pitch.get(), i))
				numberOfUnvoicedFrames ++;
		}
		theResult [11] = numberOfFrames > 0 ? double (numberOfUnvoicedFrames) / numberOfFrames : NAN;

		/*
			CPPS needs at least a few pitch periods; compute it on the selected part only.
		*/
		autoSound part = Sound_extractPart (theSound.get(), tmin, tmax, kSound_windowShape::RECTANGULAR, 1.0, false);
		if (part -> xmax - part -> xmin > 0.1) {
			autoPowerCepstrogram cepstrogram = Sound_to_PowerCepstrogram (part.get(), 60.0, 0.01, 5000.0, 50.0);
			theResult [7] = orNaN (PowerCepstrogram_getCPPS (cepstrogram.get(), true, 0.02, 0.0005, 60.0, 330.0, 0.05,
					kVector_peakInterpolation::PARABOLIC, 0.001, 0.05,
					kCepstrum_trendType::DEFAULT, kCepstrum_trendFit::LEAST_SQUARES));
		}
		return result ();
	} catch (MelderError) {
		rememberError ();
		return nullptr;
	}
}

/* End of file praat_web.cpp */
