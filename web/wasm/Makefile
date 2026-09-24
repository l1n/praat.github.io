# Builds Praat's analysis core (no GUI, no graphics, no audio) to WebAssembly
# with Emscripten, plus the small C API in praat_web.cpp used by the web app.
#
#   source emsdk/emsdk_env.sh
#   make -C web/wasm -j4
#
# Objects go into web/wasm/build so the Praat source tree stays clean.
# Each library is compiled from the OBJECTS list in its own Praat Makefile into a
# static archive; the linker then only pulls in the objects that praat_web.cpp needs.

.DEFAULT_GOAL := all

SRC := ../..
BUILD := build
OUT := ../public/wasm

LIBDIRS := melder kar sys dwsys stat fon LPC dwtools foned external/gsl external/clapack external/zlib

INCLUDES := -Iinclude $(addprefix -I$(SRC)/,kar melder sys dwsys stat fon dwtools LPC foned EEG \
	external/gsl external/num external/clapack external/portaudio external/flac external/mp3 \
	external/espeak external/whispercpp external/vorbis external/opusfile)

DEFINES := -DUNIX -Dlinux -DNO_GRAPHICS -DNO_AUDIO -D_FILE_OFFSET_BITS=64
OPT := -O3
CFLAGS := -std=gnu99 $(OPT) $(DEFINES) $(INCLUDES) -Wno-everything
CXXFLAGS := -std=c++17 $(OPT) $(DEFINES) $(INCLUDES) -Wno-everything -fexceptions

# Files that drag in the GUI, interpreter menus, audio devices or speech recognition,
# none of which exist in the browser build.
EXCLUDE := %/praat_%.cpp %/manual_%.cpp %Editor.cpp %Editor_%.cpp %/SpeechRecognizer.cpp \
	%_tests.cpp %/Sound_audio.cpp %/Movie.cpp %/Photo.cpp

define lib_rules
$(1)_NAMES := $$(basename $$(shell $(MAKE) -s --no-print-directory -C $(SRC)/$(1) --eval 'print-objects: ; @echo $$$$(OBJECTS)' print-objects))
$(1)_SRCS := $$(filter-out $$(EXCLUDE),$$(foreach n,$$($(1)_NAMES),$$(firstword $$(wildcard $(SRC)/$(1)/$$(n).cpp $(SRC)/$(1)/$$(n).c))))
$(1)_OBJS := $$(patsubst $(SRC)/%,$(BUILD)/%.o,$$($(1)_SRCS))
$(BUILD)/lib$(subst /,_,$(1)).a: $$($(1)_OBJS)
	@rm -f $$@
	emar rcs $$@ $$^
LIBS += $(BUILD)/lib$(subst /,_,$(1)).a
endef
$(foreach d,$(LIBDIRS),$(eval $(call lib_rules,$(d))))

$(BUILD)/%.cpp.o: $(SRC)/%.cpp
	@mkdir -p $(dir $@)
	em++ $(CXXFLAGS) -c $< -o $@

$(BUILD)/%.c.o: $(SRC)/%.c
	@mkdir -p $(dir $@)
	emcc $(CFLAGS) -c $< -o $@

# All functions in praat_web.cpp whose names start with pw_ are exported.
EXPORTS := $(shell ./exports.sh)

LDFLAGS := $(OPT) -fexceptions \
	-sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPraat \
	-sENVIRONMENT=web,worker,node \
	-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sSTACK_SIZE=4MB \
	-sEXPORTED_FUNCTIONS=_malloc,_free,$(EXPORTS) \
	-sEXPORTED_RUNTIME_METHODS=HEAPF32,HEAPF64,UTF8ToString \
	-sFILESYSTEM=0 -Wl,--gc-sections

.PHONY: all clean
all: $(OUT)/praat.mjs

$(BUILD)/praat_web.o: praat_web.cpp
	@mkdir -p $(BUILD)
	em++ $(CXXFLAGS) -c $< -o $@

# Libraries are listed twice to resolve circular dependencies between them.
$(OUT)/praat.mjs: $(BUILD)/praat_web.o $(LIBS)
	@mkdir -p $(OUT)
	em++ $(LDFLAGS) -o $@ $(BUILD)/praat_web.o -Wl,--start-group $(LIBS) -Wl,--end-group

libs: $(LIBS)

clean:
	rm -rf $(BUILD) $(OUT)
