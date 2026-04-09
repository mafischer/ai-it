import re
with open('app/builder.js', 'r') as f:
    text = f.read()

match = re.search(r'\}\s*;\s*\n\}\s*;\s*\n\}\s*\)\s*\(\s*\)\s*;', text)
if match:
    text = text[:match.end()]
else:
    idx = text.find('})();')
    if idx != -1:
        text = text[:idx + 5] + '\n'

with open('app/builder.js', 'w') as f:
    f.write(text)
