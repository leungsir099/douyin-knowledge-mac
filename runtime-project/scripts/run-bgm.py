import argparse
import json
import pathlib
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model
from transformers import AutoProcessor, AutoModelForAudioClassification
import librosa

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    output_dir = pathlib.Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. 人声BGM分离
    model = get_model("htdemucs")
    model.cpu()
    wav, sr = librosa.load(args.input, sr=model.samplerate, mono=False)
    wav = torch.tensor(wav).unsqueeze(0)
    ref = wav.mean(1)
    wav = (wav - ref.mean()) / ref.std()
    sources = apply_model(model, wav, split=True, overlap=0.25, progress=False)[0]
    sources = sources * ref.std() + ref.mean()
    sources = sources.cpu().numpy()

    vocal_path = output_dir / "人声.wav"
    bgm_path = output_dir / "纯背景音乐.wav"
    import soundfile as sf
    sf.write(vocal_path, sources[model.sources.index("vocals")].T, model.samplerate)
    sf.write(bgm_path, sources[model.sources.index("other")].T + sources[model.sources.index("bass")].T + sources[model.sources.index("drums")].T, model.samplerate)

    # 2. BGM曲风识别
    processor = AutoProcessor.from_pretrained("MIT/ast-finetuned-audioset-10-10-0.4593")
    cls_model = AutoModelForAudioClassification.from_pretrained("MIT/ast-finetuned-audioset-10-10-0.4593")
    audio, _ = librosa.load(bgm_path, sr=16000)
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt")
    with torch.no_grad():
        logits = cls_model(**inputs).logits
    predicted_ids = torch.topk(logits, 5).indices[0].tolist()
    labels = [cls_model.config.id2label[i] for i in predicted_ids]

    result = {
        "vocal_path": str(vocal_path),
        "bgm_path": str(bgm_path),
        "bgm_tags": labels,
    }
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
