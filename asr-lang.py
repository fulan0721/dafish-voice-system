import os,sys
import soundfile as sf, sherpa_onnx
base=os.path.join(os.path.expanduser("~"),".dsh","speech-to-text","sensevoice","models","sensevoice-onnx")
rec=sherpa_onnx.OfflineRecognizer.from_sense_voice(model=os.path.join(base,"model.int8.onnx"),tokens=os.path.join(base,"tokens.txt"),num_threads=4,use_itn=True,language=os.environ.get("ASR_LANG","auto"),debug=False)
s,sr=sf.read(sys.argv[1],dtype="float32")
if s.ndim>1: s=s.mean(axis=1)
st=rec.create_stream(); st.accept_waveform(sr,s); rec.decode_stream(st)
print(st.result.text.strip())
