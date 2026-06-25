#!/bin/bash
# Liste les images d'un dossier Cloudinary
# Usage: ./scripts/list-cloudinary-folder.sh <nom_du_dossier>
# Exemple: ./scripts/list-cloudinary-folder.sh NYC

set -e

FOLDER="${1:-NYC}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"

if [ -f "$ENV_FILE" ]; then
  export $(grep -v '^#' "$ENV_FILE" | xargs)
else
  echo "Fichier .env introuvable à $ENV_FILE" >&2
  exit 1
fi

echo "Dossier : $FOLDER"
echo "---"

curl -s -X POST "https://api.cloudinary.com/v1_1/$CLOUDINARY_CLOUD_NAME/resources/search" \
  -u "$CLOUDINARY_API_KEY:$CLOUDINARY_API_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"expression\": \"asset_folder:$FOLDER\", \"max_results\": 500}" \
| python3 -c "
import json, sys
data = json.load(sys.stdin)
resources = data.get('resources', [])
print(f'Total : {len(resources)} images\n')
for r in resources:
    print(r['public_id'])
    print(' ', r['secure_url'])
"
