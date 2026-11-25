"""Compact vector architecture for the revised ECHO-AI paper."""
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import fitz

pdfmetrics.registerFont(TTFont('PaperSans','/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'))
pdfmetrics.registerFont(TTFont('PaperBold','/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'))
c=canvas.Canvas('architecture_refined.pdf',pagesize=(452,222),initialFontName='PaperSans')

def text(x,y,value,size=8.3,color='#26364A',bold=False):
    c.setFillColor(HexColor(color));c.setFont('PaperBold' if bold else 'PaperSans',size);c.drawString(x,y,value)

def box(x,y,w,h,title,lines,color,fill):
    c.setFillColor(HexColor(fill));c.setStrokeColor(HexColor(color));c.setLineWidth(.6)
    c.roundRect(x,y,w,h,5,stroke=1,fill=1)
    dark={'#7299BC':'#245F96','#8B74B9':'#674593','#62A28E':'#237B65','#C69C5C':'#9B6421','#75AC9D':'#237B65'}
    text(x+7,y+h-13,title,8.8,dark.get(color,color),True)
    for i,line in enumerate(lines):text(x+7,y+h-27-i*11,line)

def arrow(x1,y1,x2,y2,color='#52667A'):
    import math
    angle=math.atan2(y2-y1,x2-x1)
    c.setStrokeColor(HexColor(color));c.setFillColor(HexColor(color));c.setLineWidth(.9)
    c.line(x1,y1,x2,y2)
    p=c.beginPath();p.moveTo(x2,y2)
    p.lineTo(x2-4.5*math.cos(angle)+2*math.sin(angle),y2-4.5*math.sin(angle)-2*math.cos(angle))
    p.lineTo(x2-4.5*math.cos(angle)-2*math.sin(angle),y2-4.5*math.sin(angle)+2*math.cos(angle))
    p.close();c.drawPath(p,fill=1,stroke=0)

text(5,211,'LIVE MEETING: CONTEXT, EVIDENCE SELECTION AND RESPONSE CONTROL',9.1,'#245F96',True)
box(4,121,132,80,'RTMS meeting context',[
    'Screen frames + streaming ASR','Timestamped speaker turns','Question by chat or voice'], '#7299BC','#F0F6FC')
box(156,121,142,80,'Intent-aware evidence selection',[
    'Rule-based visual / speech focus','Withhold frames for speech recall','RAG: PubMed / prior sessions','Use time-valid distinct frames'], '#8B74B9','#F4F1FA')
box(320,121,128,80,'Grounding and delivery',[
    'Vision-language draft','Text response formatting','Citation-ID whitelist','Reply in Zoom chat'], '#62A28E','#EFF8F4')
arrow(136,163,156,163);arrow(298,163,320,163)
text(299,173,'ready',6.5,'#52667A')
box(4,67,132,45,'After session ends',[
    'Transcript, slides and Q&A','Session summary'], '#7299BC','#F0F6FC')
box(156,67,142,39,'Visual + no usable frame',[
    'Availability gate before drafting'], '#C69C5C','#FFF6EA')
box(320,67,128,39,'Unavailable-screen reply',[
    'Generation bypassed'], '#C69C5C','#FFF6EA')
arrow(227,121,227,106,'#AE7B32');arrow(298,86,320,86,'#AE7B32')
text(5,54,'PUBLIC WEB: LITERATURE-ONLY ACCESS',9.1,'#237B65',True)
box(4,4,132,43,'Public literature question',['No Zoom credentials'], '#75AC9D','#EDF7F3')
box(156,4,142,43,'PubMed evidence retrieval',['Institutional index disabled'], '#75AC9D','#EDF7F3')
box(320,4,128,43,'Shared response pipeline',['Answer in web chat'], '#75AC9D','#EDF7F3')
arrow(136,24,156,24,'#237B65');arrow(298,24,320,24,'#237B65')
c.showPage();c.save()
p=fitz.open('architecture_refined.pdf')[0]
p.get_pixmap(matrix=fitz.Matrix(3,3),alpha=False).save('architecture_refined.png')
