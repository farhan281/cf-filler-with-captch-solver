#!/usr/bin/env python3
"""
hcaptcha_cnn_solver.py — Persistent CNN-based hCaptcha solver server.

Protocol (stdin/stdout, line-delimited JSON):
  Input:  {"task": "<label>", "images": ["<base64_png>", ...]}
       or {"task": "<label>", "urls":   ["<url>", ...]}
  Output: {"indices": [0, 2, 5], "label": "<matched_label>"}
          {"indices": [], "error": "<msg>"}
"""

import sys, json, base64, io, re, os
import torch
import torch.nn.functional as F
import torchvision.transforms as T
import torchvision.models as models
import numpy as np
from PIL import Image

os.environ.setdefault('PYTHONWARNINGS', 'ignore')
import warnings; warnings.filterwarnings('ignore')

DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'

sys.stderr.write(f'🔄 Loading CNN model (device={DEVICE})...\n')
sys.stderr.flush()

_weights = models.MobileNet_V3_Small_Weights.IMAGENET1K_V1
_model   = models.mobilenet_v3_small(weights=_weights)
_model.eval().to(DEVICE)

class _FeatureExtractor(torch.nn.Module):
    def __init__(self, m):
        super().__init__()
        self.features   = m.features
        self.avgpool    = m.avgpool
        self.linear     = m.classifier[0]
        self.activation = m.classifier[1]
    def forward(self, x):
        x = self.features(x)
        x = self.avgpool(x)
        x = x.flatten(1)
        x = self.linear(x)
        x = self.activation(x)
        return x

_feature_model = _FeatureExtractor(_model)
_feature_model.eval().to(DEVICE)

_IMAGENET_CLASSES = _weights.meta['categories']

_preprocess = T.Compose([
    T.Resize((224, 224)),
    T.ToTensor(),
    T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

sys.stderr.write('✅ CNN model loaded\n')
sys.stderr.flush()

LABEL_KEYWORDS = {
    'bicycle':       ['bicycle','bike','mountain bike','tricycle'],
    'bus':           ['bus','minibus','trolleybus','school bus'],
    'car':           ['car','sports car','convertible','limousine','racer','cab'],
    'motorcycle':    ['motorcycle','moped','motor scooter'],
    'truck':         ['truck','pickup','moving van','garbage truck','fire engine'],
    'boat':          ['boat','canoe','kayak','gondola','catamaran','speedboat'],
    'airplane':      ['airplane','airliner','warplane','jet'],
    'train':         ['train','locomotive','electric locomotive','freight car'],
    'traffic light': ['traffic light'],
    'fire hydrant':  ['fire hydrant'],
    'stop sign':     ['stop sign'],
    'bench':         ['park bench'],
    'bird':          ['bird','hen','cock','duck','goose','penguin','parrot','macaw',
                      'toucan','flamingo','hummingbird','robin','jay','magpie','crow',
                      'vulture','eagle','owl','peacock','ostrich'],
    'cat':           ['cat','tabby','tiger cat','persian cat','siamese cat',
                      'egyptian cat','cougar','lynx','leopard','lion','tiger','cheetah'],
    'dog':           ['dog','puppy','husky','poodle','bulldog','beagle',
                      'labrador retriever','golden retriever','german shepherd',
                      'dalmatian','chihuahua','dachshund','boxer','collie'],
    'horse':         ['horse','sorrel','zebra'],
    'sheep':         ['sheep','ram','bighorn'],
    'cow':           ['cow','ox','bison','water buffalo'],
    'elephant':      ['elephant','african elephant','indian elephant'],
    'bear':          ['bear','brown bear','polar bear','black bear'],
    'zebra':         ['zebra'],
    'giraffe':       ['giraffe'],
    'backpack':      ['backpack','bag'],
    'umbrella':      ['umbrella'],
    'bottle':        ['bottle','wine bottle','beer bottle','water bottle'],
    'cup':           ['cup','coffee mug'],
    'bowl':          ['mixing bowl','soup bowl'],
    'banana':        ['banana'],
    'apple':         ['granny smith'],
    'pizza':         ['pizza'],
    'donut':         ['doughnut'],
    'cake':          ['chocolate cake','birthday cake'],
    'chair':         ['folding chair','rocking chair','barber chair'],
    'couch':         ['studio couch'],
    'bed':           ['bed'],
    'toilet':        ['toilet seat'],
    'tv':            ['television','monitor','screen'],
    'laptop':        ['laptop','notebook'],
    'cell phone':    ['cell phone','mobile phone','smartphone'],
    'book':          ['book jacket'],
    'clock':         ['wall clock','analog clock','digital clock'],
    'vase':          ['vase'],
    'teddy bear':    ['teddy bear'],
    'toothbrush':    ['toothbrush'],
    'vehicle':       ['car','truck','bus','motorcycle','bicycle','van','ambulance','fire engine'],
    'animal':        ['dog','cat','bird','horse','cow','sheep','elephant','bear','zebra','giraffe'],
    'person':        ['person'],
    'bridge':        ['viaduct','suspension bridge','steel arch bridge'],
    'building':      ['church','castle','palace','monastery','barn'],
    'tree':          ['tree','palm','fig'],
    'flower':        ['daisy','sunflower','rose hip','lotus'],
    'mountain':      ['alp','cliff','valley'],
    'water':         ['lake','seashore','coral reef'],
    'road':          ['street sign','traffic light'],
}

def _get_class_indices(label: str) -> list:
    label_lower = label.lower().strip()
    keywords = None
    for key, kws in LABEL_KEYWORDS.items():
        if key in label_lower or label_lower in key:
            keywords = kws
            break
    if keywords is None:
        words = re.split(r'\W+', label_lower)
        for word in words:
            if len(word) < 3: continue
            for key, kws in LABEL_KEYWORDS.items():
                if word in key or key in word:
                    keywords = kws
                    break
            if keywords: break
    if keywords is None:
        keywords = [w for w in re.split(r'\W+', label_lower) if len(w) >= 3]
    if not keywords:
        return list(range(len(_IMAGENET_CLASSES)))
    indices = []
    for i, cls_name in enumerate(_IMAGENET_CLASSES):
        cls_lower = cls_name.lower()
        if any(kw in cls_lower or cls_lower in kw for kw in keywords):
            indices.append(i)
    return indices if indices else list(range(len(_IMAGENET_CLASSES)))

sys.stderr.write('🔄 Precomputing class prototypes...\n')
sys.stderr.flush()

with torch.no_grad():
    _classifier_weights = _model.classifier[-1].weight.data
    _classifier_weights = F.normalize(_classifier_weights, dim=1)

sys.stderr.write('✅ Prototypes ready\n')
sys.stderr.flush()

def extract_features(pil_img):
    tensor = _preprocess(pil_img.convert('RGB')).unsqueeze(0).to(DEVICE)
    with torch.no_grad():
        feats = _feature_model(tensor)
        feats = F.normalize(feats, dim=1)
    return feats.squeeze(0)

def classify_tile(feats, class_indices):
    if not class_indices:
        class_indices = list(range(len(_IMAGENET_CLASSES)))
    subset = _classifier_weights[class_indices]
    sims   = torch.mv(subset, feats)
    best_i = int(sims.argmax().item())
    score  = float(sims[best_i].item())
    return class_indices[best_i], score

def extract_features_multicrop(pil_img):
    w, h = pil_img.size
    crops = [
        pil_img,
        pil_img.crop((0, 0, w*3//4, h*3//4)),
        pil_img.crop((w//4, 0, w, h*3//4)),
        pil_img.crop((0, h//4, w*3//4, h)),
        pil_img.crop((w//4, h//4, w, h)),
    ]
    feats_list = [extract_features(c) for c in crops]
    avg = torch.stack(feats_list).mean(0)
    return F.normalize(avg, dim=0)

RELATIVE_MARGIN = 0.04
ABSOLUTE_MIN    = -0.05

def solve(task_label: str, image_b64_list: list) -> list:
    if not image_b64_list:
        return []
    class_indices = _get_class_indices(task_label)
    sys.stderr.write(f'   🎯 Label: "{task_label}" → {len(class_indices)} candidate classes\n')
    sys.stderr.flush()
    scores = []
    for i, b64 in enumerate(image_b64_list):
        try:
            img_bytes = base64.b64decode(b64)
            pil_img   = Image.open(io.BytesIO(img_bytes)).convert('RGB')
            feats     = extract_features_multicrop(pil_img)
            cls_idx, score = classify_tile(feats, class_indices)
            cls_name  = _IMAGENET_CLASSES[cls_idx]
            scores.append((i, score, cls_name))
            sys.stderr.write(f'   Tile {i}: score={score:.4f} → {cls_name}\n')
        except Exception as e:
            sys.stderr.write(f'   Tile {i} error: {e}\n')
            scores.append((i, -999.0, 'error'))
    sys.stderr.flush()
    if not scores:
        return []
    valid = [(i, s, n) for i, s, n in scores if s > ABSOLUTE_MIN]
    if not valid:
        scores.sort(key=lambda x: x[1], reverse=True)
        return [scores[0][0]] if scores else []
    max_score = max(s for _, s, _ in valid)
    threshold = max_score - RELATIVE_MARGIN
    selected  = [i for i, s, _ in valid if s >= threshold]
    sys.stderr.write(f'   ✅ Selected {len(selected)}/{len(image_b64_list)} tiles (threshold={threshold:.4f})\n')
    sys.stderr.flush()
    return selected

import urllib.request

def fetch_url(url: str):
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
            'Referer': 'https://newassets.hcaptcha.com/',
        })
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.read()
    except Exception as e:
        sys.stderr.write(f'   fetch error: {e}\n')
        sys.stderr.flush()
        return None

def solve_urls(task_label: str, urls: list) -> list:
    b64_list = []
    for url in urls:
        data = fetch_url(url)
        if data:
            b64_list.append(base64.b64encode(data).decode())
        else:
            b64_list.append('')
    return solve(task_label, b64_list)

sys.stderr.write('✅ hCaptcha CNN solver ready\n')
sys.stderr.flush()

for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    try:
        req    = json.loads(raw_line)
        label  = req.get('task', '')
        urls   = req.get('urls', [])
        images = req.get('images', [])
        if urls:
            indices = solve_urls(label, urls)
        else:
            indices = solve(label, images)
        print(json.dumps({'indices': indices, 'label': label}), flush=True)
    except Exception as e:
        print(json.dumps({'indices': [], 'error': str(e)}), flush=True)
