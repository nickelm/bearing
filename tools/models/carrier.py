# Generates src/render/common/models/specs/alliance-carrier.json (decision 106): the carrier has
# hundreds of deck parts, so its spec is written by this script. Run:
#   python3 tools/models/carrier.py src/render/common/models/specs/alliance-carrier.json
import json, sys
parts=[]
def box(g,c,s,**k): parts.append(dict(type='box',group=g,center=c,size=s,**k))
def cyl(g,a,b,r,sides,**k): parts.append(dict(type='cylinder',group=g,**{'from':a},to=b,radius=r,sides=sides,**k))
# Hull: origin at the waterline, bow +x.
st=[(168,8,0.5,0.6),(150,10,6,0.5),(120,13,14,0.6),(80,14,18,0.7),(30,14,20,0.75),(-30,14,20,0.75),(-90,14,19,0.75),(-140,13,17,0.75),(-162,13,15,0.8)]
parts.append(dict(type='loft',group='hull',sides=8,stations=[dict(x=x,y=y-6,w=w,h=h if h>1 else 15,square=sq) for x,y,w,h,sq in [(a,b,c,15,d) for a,b,c,d in st]]))
# Waterline band.
parts.append(dict(type='loft',group='waterline',sides=8,stations=[dict(x=x,y=-1,w=w+0.3,h=2.2,square=0.8) for x,_,w,_ in st[1:]]))
# Flight deck, angled deck, sponsons.
box('flight-deck',[2,22.6,3],[330,1.2,74])
box('flight-deck',[-40,22.7,-14],[200,1.0,36],yaw=9)
for x,z in [(110,-30),(60,36),(-40,36),(-120,-28),(-10,-38)]:
    box('hull',[x,18,z],[26,8,10],bevel=1)
# Deck markings: angled-deck centerline and catapult tracks.
box('paint-white',[-40,23.25,-14],[190,0.1,0.8],yaw=9)
for z in (-8,8): box('steel',[110,23.2,z],[80,0.1,0.8])
box('steel',[60,23.2,-26],[70,0.1,0.8],yaw=-6)
# Elevators.
for x,z in [(40,37),(10,37),(-90,37),(-60,-36)]: box('deck',[x,22.4,z],[20,0.8,16])
# Island (starboard), stepped, with masts and radars.
box('hull',[-10,30,30],[36,14,11],bevel=0.6)
box('hull',[-12,40,30],[26,8,10],bevel=0.5)
box('hull',[-14,46.5,30],[16,5,9],bevel=0.4)
box('glass',[-6,46.8,30],[1,1.6,9.2])
box('glass',[2.1,40,30],[0.2,1.6,10.2])
parts.append(dict(type='mast',group='mast',center=[-14,49,30],height=16,base=4,top=1.2))
box('mast',[-14,65.5,30],[1.6,1,8],bevel=0.2)
box('paint-white',[-8,51,30],[4,6,1],yaw=25)
box('paint-white',[-20,51,30],[4,6,1],yaw=-25)
parts.append(dict(type='blob',group='paint-white',center=[-22,49,26],radius=[2,2,2],detail=1))
parts.append(dict(type='blob',group='paint-white',center=[-4,49,34],radius=[1.6,1.6,1.6],detail=1))
# Hull number on the island (painted panels as large digits: a simple 7-segment style "73").
def seg(cx,cy,horizontal):
    box('paint-white',[cx, cy, 35.6],[0.2,0.5,0] if False else ([3,0.5,0.15] if horizontal else [0.5,3,0.15]))
# Painted number boxes face +z; build as thin boxes on the island's starboard face.
for (x0,digit) in [(-20,'7'),(-14,'3')]:
    segs={'7':['a','b','c'],'3':['a','b','g','c','d']}[digit]
    pos={'a':(0,3,True),'b':(1.5,1.5,False),'c':(1.5,-1.5,False),'d':(0,-3,True),'g':(0,0,True)}
    for s in segs:
        dx,dy,h=pos[s]
        box('paint-white',[x0+dx,30+dy,35.6],[3,0.5,0.15] if h else [0.5,3,0.15])
# CIWS and launchers on the sponsons.
for x,z in [(118,-34),(64,40),(-44,40),(-124,-32)]:
    box('hull',[x,25,z],[5,3,5])
    cyl('paint-white',[x,26.5,z],[x,30,z],1.2,8)
    parts.append(dict(type='blob',group='paint-white',center=[x,30,z],radius=[1.2,1.4,1.2],detail=1,half=True))
    cyl('steel',[x+0.5,28,z],[x+3,28,z],0.25,4)
# Parked aircraft along the deck edges (simplified: fuselage, wings, fin).
for i in range(14):
    x=130-i*15
    if -30< x < 10: continue
    z=-28 if i%2==0 else 22
    if z>0 and -40<x<20: continue
    box('deck-aircraft',[x,24.5,z],[15,1.6,2],bevel=0.3)
    parts.append(dict(type='wing',group='deck-aircraft',root=[x+1,24.2,0.9+z],rootChord=4,tipChord=1,span=3.5,sweep=45,thickness=0.05))
    parts.append(dict(type='wing',group='deck-aircraft',root=[x+1,24.2,z-0.9],rootChord=4,tipChord=1,span=3.5,sweep=45,thickness=0.05,dihedral=180))
    parts.append(dict(type='wing',group='deck-aircraft',root=[x-4.5,25.2,z],rootChord=3,tipChord=1,span=3,sweep=45,vertical=True,thickness=0.05))
# Boats and antennas along the hull.
for x in (90,50,-70,-110): box('paint-white',[x,15,-20.4],[8,2.5,1.5],bevel=0.4)
for x in (140,-150): cyl('mast',[x,23,-30],[x,33,-30],0.2,4)
spec=dict(name='CVN-73 Resolute',**{'class':'carrier'},scheme='alliance-ship',
  groups={'hull':'camo','waterline':'waterline','flight-deck':'flight-deck','deck':'deck','mast':'mast','paint-white':'paint-white','steel':'steel','glass':'glass','deck-aircraft':'#9AA1A8'},
  parts=parts, ground=False,
  emissives=[dict(kind='nav-red',at=[20,48,-36]),dict(kind='nav-green',at=[20,48,36]),dict(kind='nav-white',at=[-14,66,30]),dict(kind='runway',at=[-100,23.4,-10]),dict(kind='runway',at=[0,23.4,-38],mirror=True),dict(kind='runway',at=[100,23.4,-36],mirror=True)])
json.dump(spec,open(sys.argv[1],'w'),indent=1)
