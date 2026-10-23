import os
import sys
import soundfile as sf
import sherpa_onnx

BASE = os.environ.get("ASR_MODEL_DIR") or os.path.join(
    os.path.expanduser("~"), ".dsh", "speech-to-text", "sensevoice", "models", "sensevoice-onnx"
)
model = os.path.join(BASE, "model.int8.onnx")
tokens = os.path.join(BASE, "tokens.txt")

if not os.path.exists(model):
    print("")
    sys.exit(0)

samples, sr = sf.read(sys.argv[1], dtype="float32")
if samples.ndim > 1:
    samples = samples.mean(axis=1)
if sr != 16000:
    print("")
    sys.exit(0)

recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
    model=model, tokens=tokens, num_threads=4, use_itn=True,
    language=os.environ.get("ASR_LANG", "auto"), debug=False
)
stream = recognizer.create_stream()
stream.accept_waveform(sr, samples)
recognizer.decode_stream(stream)
print(stream.result.text.strip())
