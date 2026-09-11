# pyOCD debugger
# Copyright (c) 2013-2021 Arm Limited
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from ...coresight.coresight_target import CoreSightTarget
# from ..family import target_kinetis
# from . import target_MIMXRT1011xxxxx
# from . import target_MIMXRT1015xxxxx
# from . import target_MIMXRT1021xxxxx
# from . import target_MIMXRT1024xxxxx
# from . import target_MIMXRT1052xxxxB
# from . import target_MIMXRT1062xxxxA
# from . import target_MIMXRT1064xxxxA
# from . import target_MIMXRT1176xxxxx
# from . import target_MKE15Z256xxx7
# from . import target_MKE17Z256xxx7
# from . import target_MKE18F256xxx16
# from . import target_MKL02Z32xxx4
# from . import target_MKL05Z32xxx4
# from . import target_MKL25Z128xxx4
# from . import target_MKL26Z256xxx4
# from . import target_MKL27Z256xxx4
# from . import target_MKL28Z512xxx7
# from . import target_MKL43Z256xxx4
# from . import target_MKL46Z256xxx4
# from . import target_MKL82Z128xxx7
# from . import target_MKV10Z128xxx7
# from . import target_MKV11Z128xxx7
# from . import target_MKW01Z128xxx4
# from . import target_MKW24D512xxx5
# from . import target_MKW36Z512xxx4
# from . import target_MKW40Z160xxx4
# from . import target_MKW41Z512xxx4
# from . import target_MK22FN1M0Axxx12
# from . import target_MK22FN512xxx12
# from . import target_MK28FN2M0xxx15
# from . import target_MK64FN1M0xxx12
# from . import target_MK66FN2M0xxx18
# from . import target_MK82FN256xxx15
# from . import target_MK20DX128xxx5
# from . import target_K32W042S1M2xxx
# from . import target_K32L2B
# from . import target_lpc800
# from . import target_LPC845
# from . import target_LPC11U24FBD64_401
# from . import target_LPC1768
# from . import target_LPC4330
# from . import target_nRF51822_xxAA
# from . import target_nRF52832_xxAA
# from . import target_nRF52833_xxAA
# from . import target_nRF52840_xxAA
# from . import target_nRF54LM20A
# from . import target_nRF54L15
# from . import target_nRF91xx
# from . import target_S32K344
from .st import target_STM32F051T8
from .st import target_STM32F103RC
from .st import target_STM32F103xx
from .st import target_STM32F105xx
from .st import target_STM32F107xx
from .st import target_STM32F412xx
from .st import target_STM32F429xx
from .st import target_STM32F407xx
from .st import target_STM32F439xx
from .st import target_STM32F767xx
from .st import target_STM32H723xx
from .st import target_STM32H743xx
from .st import target_STM32H750xx
from .st import target_STM32H7B0xx
from .st import target_STM32L031x6
from .st import target_STM32L432xx
from .st import target_STM32L475xx
# from . import target_MAX32600
# from . import target_MAX32620
# from . import target_MAX32625
# from . import target_MAX32630
# from . import target_MAX32660
# from . import target_MAX32666
# from . import target_MAX32670
# from . import target_w7500
# from . import target_s5js100
# from . import target_LPC1114FN28_102
# from . import target_LPC824M201JHI33
# from . import target_LPC54114J256BD64
# from . import target_LPC54608J512ET180
# from . import target_ncs36510
# from . import target_LPC4088FBD144
# from . import target_lpc4088qsb
# from . import target_lpc4088dm
# from . import target_RTL8195AM
# from . import target_RTL8762C
# from . import target_CC3220SF
# from . import target_CC3220SF
# from ..family import target_psoc6
# from .cypress import target_CY8C6xxA
# from .cypress import target_CY8C6xx7
# from .cypress import target_CY8C6xx5
# from .cypress import target_CY8C64xx
# from .cypress import target_CY8C64xA
# from .cypress import target_CY8C64x5
# from . import target_musca_a1
# from . import target_musca_b1
# from . import target_musca_s1
# from . import target_LPC5526Jxxxxx
# from . import target_LPC55S69Jxxxxx
# from . import target_LPC55S16
# from . import target_LPC55S36
# from . import target_LPC55S28Jxxxxx
# from . import target_M251
# from . import target_M261
# from . import target_M460
# from . import target_M480
# from . import target_M2354
# from . import target_HC32F334
# from . import target_HC32F448
# from . import target_HC32F45x
# from . import target_HC32F460
# from . import target_HC32F467
# from . import target_HC32F472
# from . import target_HC32F4A0
# from . import target_HC32M423
# from . import target_HC32F115
# from . import target_HC32F155
# from . import target_HC32F160
# from . import target_HC32x120
# from . import target_HC32L110
# from . import target_HC32L13x
# from . import target_HC32L19x
# from . import target_HC32L07x
# from . import target_MPS2_AN521
# from . import target_MPS3_AN522
# from . import target_MPS3_AN540
# from ..family import target_rp2
# from . import target_ytm32b1ld0
# from . import target_ytm32b1le0
# from . import target_ytm32b1me0
# from . import target_ytm32b1md1
# from . import target_STM32H723xx
# from . import target_STM32H743xx
# from . import target_STM32H750xx
# from . import target_STM32H7B0xx
# from . import target_Air001
# from . import target_Air32F103xx
# from . import target_AMA3B1KK

from .geehy import target_G32F401x8
from .geehy import target_G32F463xC
from .geehy import target_APM32F402xx
from .geehy import target_APM32F403xx
from .geehy import target_APM32F405xx
from .geehy import target_APM32F407xx
from .geehy import target_APM32F411xx
from .geehy import target_APM32F415xx
from .geehy import target_APM32F417xx
from .geehy import target_APM32F423xx
from .geehy import target_APM32F425xx
from .geehy import target_APM32F427xx
from .geehy import target_APM32F465xx

## @brief Dictionary of all builtin targets.
#
# @note Target type names must be a valid C identifier, normalised to all lowercase, using _underscores_
#   instead of dashes punctuation. See pyocd.target.normalise_target_type_name() for the code that
#   normalises user-provided target type names for comparison with these.
BUILTIN_TARGETS = {
          'cortex_m': CoreSightTarget,
          'stm32f051' : target_STM32F051T8.STM32F051,
          'stm32f103rc' : target_STM32F103RC.STM32F103RC,
          'stm32f103c8' : target_STM32F103xx.STM32F103C8,
          'stm32f103cb' : target_STM32F103xx.STM32F103CB,
          'stm32f103rb' : target_STM32F103xx.STM32F103RB,
          'stm32f103ve' : target_STM32F103xx.STM32F103VE,
          'stm32f103ze' : target_STM32F103xx.STM32F103ZE,
          'stm32f103zg' : target_STM32F103xx.STM32F103ZG,
          'stm32f105rb' : target_STM32F105xx.STM32F105RB,
          'stm32f105rc' : target_STM32F105xx.STM32F105RC,
          'stm32f105vc' : target_STM32F105xx.STM32F105VC,
          'stm32f107rb' : target_STM32F107xx.STM32F107RB,
          'stm32f107rc' : target_STM32F107xx.STM32F107RC,
          'stm32f107vc' : target_STM32F107xx.STM32F107VC,
          'stm32f412xe' : target_STM32F412xx.STM32F412xE,
          'stm32f412xg' : target_STM32F412xx.STM32F412xG,
          'stm32f407xg' : target_STM32F407xx.STM32F407xG,
          'stm32f429xg' : target_STM32F429xx.STM32F429xG,
          'stm32f429xi' : target_STM32F429xx.STM32F429xI,
          'stm32f439xg' : target_STM32F439xx.STM32F439xG,
          'stm32f439xi' : target_STM32F439xx.STM32F439xI,
          'stm32f767xx' : target_STM32F767xx.STM32F767xx,
          'stm32h723xx' : target_STM32H723xx.STM32H723xx,
          'stm32h743xx' : target_STM32H743xx.STM32H743xx,
          'stm32h750xx' : target_STM32H750xx.STM32H750xx,
          'stm32h7b0xx' : target_STM32H7B0xx.STM32H7B0xx,
          'stm32l031x6' : target_STM32L031x6.STM32L031x6,
          'stm32l432xc' : target_STM32L432xx.STM32L432xC,
          'stm32l475xc' : target_STM32L475xx.STM32L475xC,
          'stm32l475xe' : target_STM32L475xx.STM32L475xE,
          'stm32l475xg' : target_STM32L475xx.STM32L475xG,
          'g32f463xc' : target_G32F463xC.G32F463xC,
          'g32f401x8' : target_G32F401x8.G32F401x8,
          'apm32f402xb' : target_APM32F402xx.APM32F402xB,
          'apm32f403xb' : target_APM32F403xx.APM32F403xB,
          'apm32f405xg' : target_APM32F405xx.APM32F405xG,
          'apm32f407xe' : target_APM32F407xx.APM32F407xE,
          'apm32f407xg' : target_APM32F407xx.APM32F407xG,
          'apm32f411xc' : target_APM32F411xx.APM32F411xC,
          'apm32f411xe' : target_APM32F411xx.APM32F411xE,
          'apm32f415xg' : target_APM32F415xx.APM32F415xG,
          'apm32f417xe' : target_APM32F417xx.APM32F417xE,
          'apm32f417xg' : target_APM32F417xx.APM32F417xG,
          'apm32f423xg' : target_APM32F423xx.APM32F423xG,
          'apm32f425xg' : target_APM32F425xx.APM32F425xG,
          'apm32f427xg' : target_APM32F427xx.APM32F427xG,
          'apm32f465xe' : target_APM32F465xx.APM32F465xE,
         }
